import { useState, useEffect, useRef } from 'react';
import { db, storage } from '../firebase';
import { doc, onSnapshot, setDoc, getDoc, getDocs, updateDoc, query, collection, orderBy, limit, where, writeBatch, serverTimestamp, deleteDoc, deleteField } from 'firebase/firestore';
import { ref, getDownloadURL, uploadBytes } from 'firebase/storage';
import { t } from '../data/translations';
import { isAdmin, ADMIN_NAMES, DEFAULT_STAFF, LOCATION_LABELS } from '../data/staff';
import { INVENTORY_CATEGORIES } from '../data/inventory';
import { MENU_DATA } from '../data/menu';
import { SCHEDULE_DATA } from '../data/schedule';
import InventoryHistory from './InventoryHistory';

// Constants
const TIME_PERIODS = [{ id: "all", nameEn: "All Tasks", nameEs: "Todas las Tareas" }];
const DEFAULT_CHECKLIST_TASKS = { FOH: { all: [] }, BOH: { all: [] } };
const CHECKLIST_VERSION = 2;

export default function Operations({ language, staffList, staffName, storeLocation }) {

            const [passwordEntered, setPasswordEntered] = useState(false);
            const [password, setPassword] = useState("");
            const [inventory, setInventory] = useState({});
            const [invCountMeta, setInvCountMeta] = useState({}); // { itemId: { by, at } }
            const [activeTab, setActiveTab] = useState("checklist");
            const [lastUpdated, setLastUpdated] = useState({});
            const [editMode, setEditMode] = useState(false);
            const [editingIdx, setEditingIdx] = useState(null);
            const [editTask, setEditTask] = useState("");
            const [editRequirePhoto, setEditRequirePhoto] = useState(false);
            const [editSubtasks, setEditSubtasks] = useState([]);
            const [editCompleteBy, setEditCompleteBy] = useState("");
            const [editAssignTo, setEditAssignTo] = useState("");
            const [editFollowUp, setEditFollowUp] = useState(null); // { type: "dropdown"|"text", question: "", options: [] }
            const [showAddForm, setShowAddForm] = useState(false);
            const [newTask, setNewTask] = useState("");
            const [newRequirePhoto, setNewRequirePhoto] = useState(false);
            const [newSubtasks, setNewSubtasks] = useState([]);
            const [newCompleteBy, setNewCompleteBy] = useState("");
            const [newAssignTo, setNewAssignTo] = useState("");
            const [newFollowUp, setNewFollowUp] = useState(null); // { type: "dropdown"|"text", question: "", options: [] }
            // Follow-up answers state (keyed by task id)
            const [followUpAnswers, setFollowUpAnswers] = useState({});
            const [showFollowUpFor, setShowFollowUpFor] = useState(null); // task id to show follow-up prompt
            const [capturingPhoto, setCapturingPhoto] = useState(null); // task id being photographed
            const photoInputRef = useRef(null);

            // Determine current user's role early
            const currentIsAdmin = isAdmin(staffName);

            // New checklist system â FOH/BOH with multiple lists per side
            const staffRole = (staffList || []).find(s => s.name === staffName);
            const staffIsFOH = staffRole ? ["FOH", "Manager", "Owner", "Shift Lead"].includes(staffRole.role) : true;
            const staffSide = staffIsFOH ? "FOH" : "BOH";
            const [checklistSide, setChecklistSide] = useState(currentIsAdmin ? "FOH" : staffSide);
            const [activePeriod, setActivePeriod] = useState("all");
            const [checks, setChecksRaw] = useState({});
            const checksRef = useRef(checks);
            const setChecks = (val) => { checksRef.current = val; setChecksRaw(val); };
            const [customTasks, setCustomTasksRaw] = useState(JSON.parse(JSON.stringify(DEFAULT_CHECKLIST_TASKS)));
            const customTasksRef = useRef(customTasks);
            const setCustomTasks = (val) => { customTasksRef.current = val; setCustomTasksRaw(val); };
            const [checklistDate, setChecklistDate] = useState("");
            // Assignments: { "FOH_morning": "Emma Liliana", "BOH_afternoon": "Jose Mendoza", ... }
            const [checklistAssignments, setChecklistAssignments] = useState({});
            // Multi-list: { FOH: [{id:"FOH_0", assignee:""}], BOH: [{id:"BOH_0", assignee:""}] }
            const DEFAULT_LISTS = { FOH: [{ id: "FOH_0", assignee: "" }], BOH: [{ id: "BOH_0", assignee: "" }] };
            const [checklistLists, setChecklistListsRaw] = useState(DEFAULT_LISTS);
            const checklistListsRef = useRef(checklistLists);
            const setChecklistLists = (val) => { checklistListsRef.current = val; setChecklistListsRaw(val); };
            const [activeListIdx, setActiveListIdx] = useState(0);
            // Helper: get prefix for check keys based on list index (list 0 has no prefix for backward compat)
            const getCheckPrefix = (side, listIdx) => listIdx === 0 ? "" : side + "_L" + listIdx + "_";
            const currentPrefix = getCheckPrefix(checklistSide, activeListIdx);
            const [invEditMode, setInvEditMode] = useState(false);
            const [invEditingIdx, setInvEditingIdx] = useState(null);
            const [invEditName, setInvEditName] = useState("");
            const [invEditNameEs, setInvEditNameEs] = useState("");
            const [invEditSupplier, setInvEditSupplier] = useState("");
            const [invEditOrderDay, setInvEditOrderDay] = useState("Fri");
            const [invShowAddForm, setInvShowAddForm] = useState(null);
            const [invNewName, setInvNewName] = useState("");
            const [invNewNameEs, setInvNewNameEs] = useState("");
            const [invNewSupplier, setInvNewSupplier] = useState("");
            const [invNewOrderDay, setInvNewOrderDay] = useState("Fri");
            const [customInventory, setCustomInventory] = useState(INVENTORY_CATEGORIES.map(c => ({...c, items: [...c.items]})));
            const [showSaveConfirm, setShowSaveConfirm] = useState(false);
            const [inventorySaving, setInventorySaving] = useState(false);
            const [invSearch, setInvSearch] = useState("");
            const [writeInValues, setWriteInValues] = useState({});

            // Break Planner state
            const DEFAULT_STATIONS = [
                { id: "fry", nameEn: "Fry", nameEs: "Freidora", emoji: "ð" },
                { id: "pho", nameEn: "Pho", nameEs: "Pho", emoji: "ð²" },
                { id: "grill", nameEn: "Grill", nameEs: "Parrilla", emoji: "ð¥" },
                { id: "bao", nameEn: "Bao", nameEs: "Bao", emoji: "ð¥" },
                { id: "springroll", nameEn: "Spring Roll", nameEs: "Rollito", emoji: "ð¯" },
                { id: "wok", nameEn: "Wok", nameEs: "Wok", emoji: "ð¥" },
                { id: "bowls", nameEn: "Bowls", nameEs: "Bowls", emoji: "ð¥" },
                { id: "friedrice1", nameEn: "Fried Rice 1", nameEs: "Arroz Frito 1", emoji: "ð³" },
                { id: "friedrice2", nameEn: "Fried Rice 2", nameEs: "Arroz Frito 2", emoji: "ð³" },
                { id: "dish", nameEn: "Dish", nameEs: "Platos", emoji: "ð§½" },
                { id: "manager", nameEn: "Manager", nameEs: "Gerente", emoji: "ð" },
                { id: "prep1", nameEn: "Prep 1", nameEs: "Prep 1", emoji: "ðª" },
                { id: "prep2", nameEn: "Prep 2", nameEs: "Prep 2", emoji: "ðª" },
                { id: "prep3", nameEn: "Prep 3", nameEs: "Prep 3", emoji: "ðª" },
                { id: "prep4", nameEn: "Prep 4", nameEs: "Prep 4", emoji: "ðª" }
            ];
            const DEFAULT_BREAK_WAVES = [
                { id: "wave1", time: "13:30" },
                { id: "wave2", time: "14:30" }
            ];
            // Skill stations for the matrix (unique skills, not position slots)
            const SKILL_STATIONS = [
                { id: "fry", nameEn: "Fry", emoji: "ð" },
                { id: "pho", nameEn: "Pho", emoji: "ð²" },
                { id: "grill", nameEn: "Grill", emoji: "ð¥" },
                { id: "bao", nameEn: "Bao", emoji: "ð¥" },
                { id: "springroll", nameEn: "Spring Roll", emoji: "ð¯" },
                { id: "wok", nameEn: "Wok", emoji: "ð¥" },
                { id: "bowls", nameEn: "Bowls", emoji: "ð¥" },
                { id: "friedrice", nameEn: "Fried Rice", emoji: "ð³" },
                { id: "dish", nameEn: "Dish", emoji: "ð§½" },
                { id: "prep", nameEn: "Prep", emoji: "ðª" }
            ];
            // Map position IDs to skill IDs (fried rice 1&2 -> friedrice, prep1-4 -> prep)
            const positionToSkill = (posId) => {
                if (posId.startsWith("friedrice")) return "friedrice";
                if (posId.startsWith("prep")) return "prep";
                return posId;
            };

            const [customStations, setCustomStations] = useState(JSON.parse(JSON.stringify(DEFAULT_STATIONS)));
            const [editingStations, setEditingStations] = useState(false);
            const [newStationName, setNewStationName] = useState("");
            const [newStationEmoji, setNewStationEmoji] = useState("ð");
            const ALL_POSITIONS = customStations;

            const [breakPlan, setBreakPlan] = useState({ stations: {}, waves: {} });
            const [breakPlanSaved, setBreakPlanSaved] = useState(false);
            const [breakWaveTimes, setBreakWaveTimes] = useState(DEFAULT_BREAK_WAVES.map(w => w.time));
            const [breakDate, setBreakDate] = useState(() => {
                const d = new Date();
                return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
            });

            // Build BREAK_WAVES dynamically from editable times
            const formatTime12 = (t24) => {
                if (!t24) return "";
                const [h, m] = t24.split(":").map(Number);
                const ampm = h >= 12 ? "PM" : "AM";
                const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
                return h12 + ":" + String(m).padStart(2, "0") + " " + ampm;
            };
            const BREAK_WAVES = DEFAULT_BREAK_WAVES.map((w, i) => {
                const t = breakWaveTimes[i] || w.time;
                const display = formatTime12(t);
                return { id: w.id, time: t, displayTime: display, nameEn: `Wave ${i+1} â ${display}`, nameEs: `Grupo ${i+1} â ${display}` };
            });
            const [skillsMatrix, setSkillsMatrix] = useState({});
            const [showMatrix, setShowMatrix] = useState(false);
            const FOH_ROLES = ["FOH", "Manager", "Owner", "Shift Lead", "Marketing"];
            const bohStaff = (staffList || []).filter(s => s.role && !FOH_ROLES.includes(s.role) && (s.location === storeLocation || s.location === "both"));
            const fohStaff = (staffList || []).filter(s => FOH_ROLES.includes(s.role) && (s.location === storeLocation || s.location === "both"));

            // Load skills matrix from Firestore
            useEffect(() => {
                const unsubMatrix = onSnapshot(doc(db, "config", "skillsMatrix"), (docSnap) => {
                    if (docSnap.exists() && docSnap.data().matrix) {
                        setSkillsMatrix(docSnap.data().matrix);
                    }
                });
                return () => unsubMatrix();
            }, []);

            // Load custom stations from Firestore
            useEffect(() => {
                const unsubStations = onSnapshot(doc(db, "config", "stations"), (docSnap) => {
                    if (docSnap.exists() && docSnap.data().stations && docSnap.data().stations.length > 0) {
                        setCustomStations(docSnap.data().stations);
                    }
                });
                return () => unsubStations();
            }, []);

            const saveStations = async (stations) => {
                try {
                    await setDoc(doc(db, "config", "stations"), { stations, updatedAt: new Date().toISOString() });
                } catch (err) { console.error("Error saving stations:", err); }
            };

            const addStation = () => {
                const name = newStationName.trim();
                if (!name) return;
                const id = name.toLowerCase().replace(/[^a-z0-9]/g, "") + "_" + Date.now();
                const station = { id, nameEn: name, nameEs: name, emoji: newStationEmoji || "ð" };
                const updated = [...customStations, station];
                setCustomStations(updated);
                saveStations(updated);
                setNewStationName("");
                setNewStationEmoji("ð");
            };

            const removeStation = (stationId) => {
                if (!confirm(language === "es" ? "Â¿Eliminar esta estaciÃ³n?" : "Remove this station?")) return;
                const updated = customStations.filter(s => s.id !== stationId);
                setCustomStations(updated);
                saveStations(updated);
            };

            const renameStation = (stationId, newName) => {
                const updated = customStations.map(s => s.id === stationId ? { ...s, nameEn: newName, nameEs: newName } : s);
                setCustomStations(updated);
                saveStations(updated);
            };

            const updateStationEmoji = (stationId, newEmoji) => {
                const updated = customStations.map(s => s.id === stationId ? { ...s, emoji: newEmoji } : s);
                setCustomStations(updated);
                saveStations(updated);
            };

            const moveStation = (stationId, direction) => {
                const idx = customStations.findIndex(s => s.id === stationId);
                if (idx < 0) return;
                const newIdx = idx + direction;
                if (newIdx < 0 || newIdx >= customStations.length) return;
                const updated = [...customStations];
                [updated[idx], updated[newIdx]] = [updated[newIdx], updated[idx]];
                setCustomStations(updated);
                saveStations(updated);
            };

            const resetStationsToDefault = () => {
                if (!confirm(language === "es" ? "Â¿Restaurar estaciones predeterminadas?" : "Reset stations to defaults?")) return;
                const fresh = JSON.parse(JSON.stringify(DEFAULT_STATIONS));
                setCustomStations(fresh);
                saveStations(fresh);
            };

            const toggleSkill = async (staffName, skillId) => {
                const key = staffName + "_" + skillId;
                const newMatrix = { ...skillsMatrix, [key]: !skillsMatrix[key] };
                setSkillsMatrix(newMatrix);
                try {
                    await setDoc(doc(db, "config", "skillsMatrix"), { matrix: newMatrix, updatedAt: new Date().toISOString() });
                } catch (err) { console.error("Error saving skills matrix:", err); }
            };

            // Check if a person can work a position (based on skill matrix)
            const canWorkPosition = (personName, posId) => {
                const skillId = positionToSkill(posId);
                if (skillId === "manager") return true; // managers handled separately
                return !!skillsMatrix[personName + "_" + skillId];
            };

            // Get qualified covers for a position from available people
            const getQualifiedCovers = (posId, availablePeople, waveId) => {
                const skillId = positionToSkill(posId);
                const needCover = getPositionsNeedingCover(waveId);
                // Count how many stations each available person is already covering in this wave
                const coverLoad = {};
                needCover.forEach(nc => {
                    const c = nc.cover;
                    if (c) coverLoad[c] = (coverLoad[c] || 0) + 1;
                });
                // Filter to qualified, sort by: fewest current covers first
                return availablePeople
                    .filter(name => canWorkPosition(name, posId))
                    .sort((a, b) => (coverLoad[a] || 0) - (coverLoad[b] || 0));
            };

            // Load break plan from Firestore â keyed by selected date + location
            useEffect(() => {
                // Reset plan while loading new date/location
                setBreakPlan({ stations: {}, waves: {} });
                setBreakWaveTimes(DEFAULT_BREAK_WAVES.map(w => w.time));
                const docId = "breakPlan_" + storeLocation + "_" + breakDate;
                const unsubBreakPlan = onSnapshot(doc(db, "ops", docId), (docSnap) => {
                    if (docSnap.exists()) {
                        setBreakPlan(docSnap.data().plan || { stations: {}, waves: {} });
                        if (docSnap.data().waveTimes) setBreakWaveTimes(docSnap.data().waveTimes);
                    }
                });
                // Also migrate old single-doc format for today if needed
                if (breakDate === getTodayKey()) {
                    const oldDocId = "breakPlan_" + breakDate;
                    getDoc(doc(db, "ops", oldDocId)).then(oldDocSnap => {
                        if (oldDocSnap.exists() && oldDocSnap.data().date === breakDate && oldDocSnap.data().plan) {
                            getDoc(doc(db, "ops", docId)).then(newDocSnap => {
                                if (!newDocSnap.exists()) {
                                    setDoc(doc(db, "ops", docId), oldDocSnap.data());
                                }
                            });
                        }
                    });
                }
                return () => unsubBreakPlan();
            }, [breakDate, storeLocation]);

            const saveBreakPlan = async (plan, times) => {
                const saveTimes = times || breakWaveTimes;
                const docId = "breakPlan_" + storeLocation + "_" + breakDate;
                try {
                    await setDoc(doc(db, "ops", docId), { plan, date: breakDate, waveTimes: saveTimes, updatedAt: new Date().toISOString(), storeBranch: storeLocation });
                    setBreakPlanSaved(true);
                    setTimeout(() => setBreakPlanSaved(false), 2000);
                } catch (err) { console.error("Error saving break plan:", err); }
            };

            const updateWaveTime = (idx, newTime) => {
                const updated = [...breakWaveTimes];
                updated[idx] = newTime;
                setBreakWaveTimes(updated);
                saveBreakPlan(breakPlan, updated);
            };

            const updateStationAssignment = (posId, name) => {
                const newPlan = { ...breakPlan, stations: { ...breakPlan.stations, [posId]: name } };
                setBreakPlan(newPlan);
                saveBreakPlan(newPlan);
            };

            const clearBreakPlan = () => {
                if (!confirm(language === "es" ? "Â¿Borrar todo el plan de breaks?" : "Clear entire break plan?")) return;
                setBreakPlan({ stations: {}, waves: {} });
                saveBreakPlan({ stations: {}, waves: {} });
            };

            // Build a map: person -> position(s) they're assigned to
            const getStaffPositionMap = () => {
                const map = {};
                Object.entries(breakPlan.stations || {}).forEach(([posId, name]) => {
                    if (!name) return;
                    if (!map[name]) map[name] = [];
                    const pos = ALL_POSITIONS.find(p => p.id === posId);
                    if (pos) map[name].push(pos);
                });
                return map;
            };

            // Get who's on break in a wave (array of names)
            const getWaveBreakers = (waveId) => {
                return breakPlan.waves?.[waveId + "_breakers"] || [];
            };

            // Toggle a person on/off break for a wave
            const toggleBreaker = (waveId, personName) => {
                const breakers = [...getWaveBreakers(waveId)];
                const idx = breakers.indexOf(personName);
                if (idx >= 0) breakers.splice(idx, 1);
                else breakers.push(personName);
                const newWaves = { ...breakPlan.waves, [waveId + "_breakers"]: breakers };
                const newPlan = { ...breakPlan, waves: newWaves };
                setBreakPlan(newPlan);
                saveBreakPlan(newPlan);
            };

            // Get/set who covers a specific position during a wave
            const getWaveCover = (waveId, posId) => breakPlan.waves?.[waveId + "_cover_" + posId] || "";
            const setWaveCover = (waveId, posId, coverName) => {
                const newWaves = { ...breakPlan.waves, [waveId + "_cover_" + posId]: coverName };
                const newPlan = { ...breakPlan, waves: newWaves };
                setBreakPlan(newPlan);
                saveBreakPlan(newPlan);
            };

            // Get all assigned people
            const getAssignedStaff = () => {
                const assigned = new Set();
                Object.values(breakPlan.stations || {}).forEach(n => { if (n) assigned.add(n); });
                return [...assigned].sort();
            };

            // For a wave, get people NOT on break (available to cover)
            const getAvailableCovers = (waveId) => {
                const breakers = getWaveBreakers(waveId);
                return getAssignedStaff().filter(n => !breakers.includes(n));
            };

            // Get positions that need coverage in a wave (their assigned person is on break)
            const getPositionsNeedingCover = (waveId) => {
                const breakers = getWaveBreakers(waveId);
                const positions = [];
                Object.entries(breakPlan.stations || {}).forEach(([posId, name]) => {
                    if (name && breakers.includes(name)) {
                        const pos = ALL_POSITIONS.find(p => p.id === posId);
                        if (pos) positions.push({ pos, person: name, cover: getWaveCover(waveId, posId) });
                    }
                });
                return positions;
            };

            useEffect(() => {
                // Load checklist data (new system)
                const unsubChecklist = onSnapshot(doc(db, "ops", "checklists2_" + storeLocation), async (docSnap) => {
                    if (docSnap.exists()) {
                        const data = docSnap.data();
                        const todayKey = getTodayKey();
                        // Auto-update tasks when version changes
                        if (!data.version || data.version < CHECKLIST_VERSION) {
                            const freshTasks = JSON.parse(JSON.stringify(DEFAULT_CHECKLIST_TASKS));
                            setCustomTasks(freshTasks);
                            setChecks({});
                            setChecklistDate(todayKey);
                            try {
                                await setDoc(doc(db, "ops", "checklists2_" + storeLocation), {
                                    checks: {}, customTasks: freshTasks, date: todayKey, updatedAt: new Date().toISOString(), version: CHECKLIST_VERSION
                                });
                            } catch (err) { console.error("Error updating checklist version:", err); }
                            return;
                        }
                        // Auto-reset: if stored date != today, save previous day's final state then reset
                        if (data.date && data.date !== todayKey) {
                            // Save the previous day's completed state to history before resetting
                            try {
                                const prevChecks = data.checks || {};
                                const hasAnyChecks = Object.keys(prevChecks).some(k => !k.includes("_by") && !k.includes("_at") && !k.includes("_photo") && !k.includes("_followUp") && prevChecks[k] === true);
                                if (hasAnyChecks) {
                                    await setDoc(doc(db, "checklistHistory_" + storeLocation, data.date), {
                                        checks: prevChecks, customTasks: data.customTasks || {}, assignments: data.assignments || {}, lists: data.lists || {}, date: data.updatedAt || new Date().toISOString(), version: CHECKLIST_VERSION
                                    });
                                }
                            } catch (err) { console.error("Error saving prev day history:", err); }
                            setChecks({});
                            setChecklistDate(todayKey);
                            // Also reset the Firestore doc for the new day with empty checks
                            try {
                                await updateDoc(doc(db, "ops", "checklists2_" + storeLocation), { checks: {}, date: todayKey, updatedAt: new Date().toISOString() });
                            } catch (err) { console.error("Error resetting for new day:", err); }
                        } else {
                            setChecks(data.checks || {});
                            setChecklistDate(data.date || todayKey);
                        }
                        if (data.customTasks) {
                            // Migrate morning/afternoon â single "all" period
                            const migrated = {};
                            ["FOH", "BOH"].forEach(side => {
                                const s = data.customTasks[side] || {};
                                if (s.all) { migrated[side] = s; }
                                else {
                                    migrated[side] = { all: [...(s.morning || []), ...(s.afternoon || [])] };
                                }
                            });
                            setCustomTasks(migrated);
                        }
                        // Load checklist assignments
                        if (data.assignments) setChecklistAssignments(data.assignments);
                        // Load multi-list data
                        if (data.lists) {
                            setChecklistLists(data.lists);
                        } else {
                            // Migrate from old single-list: build lists from assignments
                            const migLists = { FOH: [{ id: "FOH_0", assignee: (data.assignments || {})["FOH_all"] || "" }], BOH: [{ id: "BOH_0", assignee: (data.assignments || {})["BOH_all"] || "" }] };
                            setChecklistLists(migLists);
                        }
                        setLastUpdated(prev => ({ ...prev, checklists: data.updatedAt ? new Date(data.updatedAt).toLocaleString() : "" }));
                    }
                });

                const inventoryDocRef = doc(db, "ops", "inventory_" + storeLocation);
                const unsubInventorySnapshot = onSnapshot(inventoryDocRef, (docSnap) => {
                    if (docSnap.exists()) {
                        const data = docSnap.data();
                        setInventory(data.counts || {});
                        setInvCountMeta(data.countMeta || {});
                        if (data.customInventory) setCustomInventory(data.customInventory);
                        setLastUpdated(prev => ({ ...prev, inventory: new Date(data.date).toLocaleString() }));
                    }
                });

                return () => { unsubChecklist(); unsubInventorySnapshot(); };
            }, [storeLocation]);

            // Midnight auto-reset: check every 60s if the date has changed
            useEffect(() => {
                let lastKnownDate = getTodayKey();
                const midnightInterval = setInterval(async () => {
                    const now = getTodayKey();
                    if (now !== lastKnownDate) {
                        lastKnownDate = now;
                        const prevChecks = checksRef.current || {};
                        const hasAnyChecks = Object.keys(prevChecks).some(k => !k.includes("_by") && !k.includes("_at") && !k.includes("_photo") && !k.includes("_followUp") && prevChecks[k] === true);
                        const prevDate = checklistDate || new Date(Date.now() - 86400000).toISOString().split("T")[0];
                        if (hasAnyChecks) {
                            try {
                                await setDoc(doc(db, "checklistHistory_" + storeLocation, prevDate + "_saved"), {
                                    checks: cleanForFirestore(prevChecks), customTasks: cleanForFirestore(customTasksRef.current), assignments: cleanForFirestore(checklistAssignments), lists: cleanForFirestore(checklistListsRef.current), date: new Date().toISOString(), savedBy: "auto-midnight"
                                });
                            } catch (err) { console.error("Midnight save error:", err); }
                        }
                        setChecks({});
                        setChecklistDate(now);
                        try {
                            await updateDoc(doc(db, "ops", "checklists2_" + storeLocation), { checks: {}, date: now, updatedAt: new Date().toISOString() });
                        } catch (err) { console.error("Midnight reset error:", err); }
                    }
                }, 60000);
                return () => clearInterval(midnightInterval);
            }, [storeLocation, checklistDate, checklistAssignments]);

            // ââ PUSH NOTIFICATION SYSTEM ââ
            // ââ NOTIFICATION SYSTEM ââ
            const [activeAlerts, setActiveAlerts] = useState([]);
            const [clockTick, setClockTick] = useState(0);
            const dismissedAlertsRef = useRef(new Set());

            const checkDeadlines = () => {
                const now = new Date();
                const currentMinutes = now.getHours() * 60 + now.getMinutes();
                const tasks = customTasksRef.current;
                const ch = checksRef.current;
                const todayKey = getTodayKey();
                const alerts = [];
                ["FOH", "BOH"].forEach(side => {
                    TIME_PERIODS.forEach(p => {
                        const periodTasks = (tasks[side] && tasks[side][p.id]) || [];
                        periodTasks.forEach(item => {
                            if (!item.completeBy || !item.assignTo) return;
                            if (item.assignTo !== staffName) return;
                            const done = item.subtasks && item.subtasks.length > 0
                                ? item.subtasks.every(s => ch[s.id])
                                : !!ch[item.id];
                            if (done) return;
                            const [h, m] = item.completeBy.split(":").map(Number);
                            const deadlineMinutes = h * 60 + m;
                            const taskName = item.task.includes("\n") ? item.task.split("\n")[0] : item.task;
                            const timeStr = item.completeBy.replace(/^0/, "");
                            // 30-minute warning
                            const warn30Key = item.id + "_30_" + todayKey;
                            if (currentMinutes >= deadlineMinutes - 30 && currentMinutes < deadlineMinutes && !dismissedAlertsRef.current.has(warn30Key)) {
                                const minsLeft = deadlineMinutes - currentMinutes;
                                alerts.push({ key: warn30Key, type: "warning", taskName, timeStr, message: `${minsLeft} min left` });
                            }
                            // At deadline or overdue
                            const dueKey = item.id + "_due_" + todayKey;
                            if (currentMinutes >= deadlineMinutes && !dismissedAlertsRef.current.has(dueKey)) {
                                const overBy = currentMinutes - deadlineMinutes;
                                alerts.push({ key: dueKey, type: "overdue", taskName, timeStr, message: overBy === 0 ? "Due NOW" : `${overBy} min overdue` });
                            }
                        });
                    });
                });
                setActiveAlerts(alerts);
                // Also try browser notification for new alerts
                if ("Notification" in window && Notification.permission === "granted") {
                    alerts.forEach(a => {
                        const nKey = "notif_" + a.key;
                        if (!dismissedAlertsRef.current.has(nKey)) {
                            dismissedAlertsRef.current.add(nKey);
                            new Notification(a.type === "overdue" ? "DD Mau - Task Due!" : "DD Mau - Reminder", {
                                body: `"${a.taskName}" â ${a.message}`,
                                tag: nKey
                            });
                        }
                    });
                }
            };

            useEffect(() => {
                if ("Notification" in window && Notification.permission === "default") {
                    Notification.requestPermission();
                }
                checkDeadlines(); // run immediately
                const interval = setInterval(() => { checkDeadlines(); setClockTick(t => t + 1); }, 30000);
                return () => clearInterval(interval);
            }, [staffName]);

            const dismissAlert = (key) => {
                dismissedAlertsRef.current.add(key);
                setActiveAlerts(prev => prev.filter(a => a.key !== key));
            };

            const getTodayKey = () => {
                const d = new Date();
                return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
            };

            // Strip undefined values from nested objects before Firestore save
            const cleanForFirestore = (obj) => {
                if (Array.isArray(obj)) return obj.map(cleanForFirestore);
                if (obj && typeof obj === "object") {
                    const clean = {};
                    Object.keys(obj).forEach(k => {
                        if (obj[k] !== undefined) clean[k] = cleanForFirestore(obj[k]);
                    });
                    return clean;
                }
                return obj;
            };

            const saveChecklistState = async (newChecks, newTasks, newAssignments, newLists) => {
                const todayKey = getTodayKey();
                const now = new Date().toISOString();
                const safeChecks = cleanForFirestore(newChecks);
                const safeTasks = cleanForFirestore(newTasks);
                const safeAssignments = cleanForFirestore(newAssignments || checklistAssignments);
                const safeLists = cleanForFirestore(newLists || checklistListsRef.current);
                try {
                    await setDoc(doc(db, "ops", "checklists2_" + storeLocation), {
                        checks: safeChecks, customTasks: safeTasks, assignments: safeAssignments, lists: safeLists, date: todayKey, updatedAt: now, version: CHECKLIST_VERSION
                    });
                    // Also save to daily history
                    await setDoc(doc(db, "checklistHistory_" + storeLocation, todayKey), {
                        checks: safeChecks, customTasks: safeTasks, assignments: safeAssignments, lists: safeLists, date: now, version: CHECKLIST_VERSION
                    });
                } catch (err) { console.error("Error saving checklist:", err); }
            };

            const assignChecklist = async (side, periodId, staffMemberName, listIdx) => {
                const li = listIdx !== undefined ? listIdx : activeListIdx;
                const key = li === 0 ? side + "_" + periodId : side + "_L" + li + "_" + periodId;
                const updated = { ...checklistAssignments, [key]: staffMemberName };
                // Also update the lists data
                const updatedLists = JSON.parse(JSON.stringify(checklistListsRef.current));
                if (updatedLists[side] && updatedLists[side][li]) {
                    updatedLists[side][li].assignee = staffMemberName;
                }
                setChecklistAssignments(updated);
                setChecklistLists(updatedLists);
                await saveChecklistState(checksRef.current, customTasksRef.current, updated, updatedLists);
            };

            const addChecklistList = async (side) => {
                const updatedLists = JSON.parse(JSON.stringify(checklistListsRef.current));
                const newIdx = updatedLists[side].length;
                updatedLists[side].push({ id: side + "_" + newIdx, assignee: "" });
                setChecklistLists(updatedLists);
                setActiveListIdx(newIdx);
                await saveChecklistState(checksRef.current, customTasksRef.current, checklistAssignments, updatedLists);
            };

            const removeChecklistList = async (side, listIdx) => {
                if (listIdx === 0) return; // Can't remove the first list
                const updatedLists = JSON.parse(JSON.stringify(checklistListsRef.current));
                updatedLists[side].splice(listIdx, 1);
                // Clean up checks for that list
                const prefix = getCheckPrefix(side, listIdx);
                const newChecks = { ...checksRef.current };
                if (prefix) {
                    Object.keys(newChecks).forEach(k => { if (k.startsWith(prefix)) delete newChecks[k]; });
                }
                // Clean up assignment
                const newAssignments = { ...checklistAssignments };
                const assignKey = side + "_L" + listIdx + "_all";
                delete newAssignments[assignKey];
                setChecklistLists(updatedLists);
                setChecks(newChecks);
                setChecklistAssignments(newAssignments);
                setActiveListIdx(Math.min(activeListIdx, updatedLists[side].length - 1));
                await saveChecklistState(newChecks, customTasksRef.current, newAssignments, updatedLists);
            };

            const handlePasswordSubmit = (e) => {
                e.preventDefault();
                if (password === "12345") { setPasswordEntered(true); setPassword(""); }
                else { alert(language === "es" ? "ContraseÃ±a incorrecta" : "Incorrect password"); }
            };

            const toggleCheckItem = async (taskId, parentTask) => {
                const cur = checksRef.current;
                const pKey = currentPrefix + taskId;
                const newVal = !cur[pKey];
                const newChecks = { ...cur, [pKey]: newVal };
                // Store who completed it and when
                if (newVal) {
                    const now = new Date();
                    const timeStr = now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
                    newChecks[pKey + "_by"] = staffName;
                    newChecks[pKey + "_at"] = timeStr;
                } else {
                    delete newChecks[pKey + "_by"];
                    delete newChecks[pKey + "_at"];
                }
                setChecks(newChecks);
                await saveChecklistState(newChecks, customTasksRef.current);
                // If checking ON and the parent task has a follow-up, check if task is now complete
                if (newVal && parentTask && parentTask.followUp && parentTask.followUp.question) {
                    const allDone = parentTask.subtasks && parentTask.subtasks.length > 0
                        ? parentTask.subtasks.every(s => (currentPrefix + s.id) === pKey ? true : newChecks[currentPrefix + s.id])
                        : true;
                    if (allDone) setShowFollowUpFor(parentTask.id);
                }
            };

            // Save a follow-up answer
            const saveFollowUpAnswer = async (taskId, answer) => {
                const pKey = currentPrefix + taskId;
                const newChecks = { ...checksRef.current, [pKey + "_followUp"]: answer };
                setChecks(newChecks);
                setFollowUpAnswers(prev => ({ ...prev, [taskId]: answer }));
                setShowFollowUpFor(null);
                await saveChecklistState(newChecks, customTasksRef.current);
            };

            const addChecklistTask = async () => {
                if (!newTask.trim()) return;
                const item = { id: Date.now().toString(), task: newTask.trim() };
                if (newRequirePhoto) item.requirePhoto = true;
                if (newCompleteBy) item.completeBy = newCompleteBy;
                if (newAssignTo) item.assignTo = newAssignTo;
                if (newFollowUp && newFollowUp.question.trim()) {
                    item.followUp = { type: newFollowUp.type, question: newFollowUp.question.trim() };
                    if (newFollowUp.type === "dropdown" && newFollowUp.options.length > 0) {
                        item.followUp.options = newFollowUp.options.filter(o => o.trim());
                    }
                }
                const cleanSubs = newSubtasks.filter(s => s.task.trim());
                if (cleanSubs.length > 0) item.subtasks = cleanSubs.map((s, i) => ({ id: item.id + "_s" + i, task: s.task.trim() }));
                const updated = JSON.parse(JSON.stringify(customTasksRef.current));
                if (!updated[checklistSide]) updated[checklistSide] = {};
                if (!updated[checklistSide][activePeriod]) updated[checklistSide][activePeriod] = [];
                updated[checklistSide][activePeriod].push(item);
                setCustomTasks(updated);
                await saveChecklistState(checksRef.current, updated);
                setNewTask(""); setNewRequirePhoto(false); setNewSubtasks([]); setNewCompleteBy(""); setNewAssignTo(""); setNewFollowUp(null); setShowAddForm(false);
            };

            const saveChecklistEdit = async (idx) => {
                if (!editTask.trim()) return;
                const updated = JSON.parse(JSON.stringify(customTasksRef.current));
                const item = updated[checklistSide][activePeriod][idx];
                item.task = editTask.trim();
                item.requirePhoto = editRequirePhoto;
                if (editCompleteBy) { item.completeBy = editCompleteBy; } else { delete item.completeBy; }
                if (editAssignTo) { item.assignTo = editAssignTo; } else { delete item.assignTo; }
                if (editFollowUp && editFollowUp.question.trim()) {
                    item.followUp = { type: editFollowUp.type, question: editFollowUp.question.trim() };
                    if (editFollowUp.type === "dropdown" && editFollowUp.options.length > 0) {
                        item.followUp.options = editFollowUp.options.filter(o => o.trim());
                    }
                } else { delete item.followUp; }
                const cleanSubs = editSubtasks.filter(s => s.task.trim());
                if (cleanSubs.length > 0) { item.subtasks = cleanSubs.map((s, i) => ({ id: (item.id || idx) + "_s" + i, task: s.task.trim() })); } else { delete item.subtasks; }
                setCustomTasks(updated);
                await saveChecklistState(checksRef.current, updated);
                setEditingIdx(null); setEditTask(""); setEditRequirePhoto(false); setEditSubtasks([]); setEditCompleteBy(""); setEditAssignTo(""); setEditFollowUp(null);
            };

            // Photo capture and upload
            const handlePhotoCapture = async (e, taskId) => {
                const file = e.target.files?.[0];
                if (!file) return;
                setCapturingPhoto(taskId);
                try {
                    const todayKey = getTodayKey();
                    const photoRef = ref(storage, "checklist-photos/" + todayKey + "/" + taskId + "_" + Date.now() + ".jpg");
                    await uploadBytes(photoRef, file);
                    const url = await getDownloadURL(photoRef);
                    const pKey = currentPrefix + taskId;
                    const newChecks = { ...checksRef.current, [pKey + "_photo"]: url, [pKey + "_photoTime"]: new Date().toISOString() };
                    setChecks(newChecks);
                    await saveChecklistState(newChecks, customTasksRef.current);
                } catch (err) { console.error("Error uploading photo:", err); alert(language === "es" ? "Error al subir foto" : "Error uploading photo"); }
                setCapturingPhoto(null);
            };

            const deleteChecklistTask = async (idx) => {
                const updated = JSON.parse(JSON.stringify(customTasksRef.current));
                updated[checklistSide][activePeriod].splice(idx, 1);
                setCustomTasks(updated);
                await saveChecklistState(checksRef.current, updated);
            };

            const resetAllChecklists = async () => {
                if (!confirm(language === "es" ? "Â¿Guardar y reiniciar todas las tareas?" : "Save & reset all checklists?")) return;
                const todayKey = getTodayKey();
                const now = new Date().toISOString();
                try {
                    await setDoc(doc(db, "checklistHistory_" + storeLocation, todayKey + "_saved"), {
                        checks: cleanForFirestore(checksRef.current), customTasks: cleanForFirestore(customTasksRef.current), assignments: cleanForFirestore(checklistAssignments), lists: cleanForFirestore(checklistListsRef.current), date: now, savedBy: staffName
                    });
                } catch (err) { console.error("Error saving history:", err); }
                setChecks({});
                await saveChecklistState({}, customTasksRef.current);
            };

            const saveInventorySnapshot = async (counts, items) => {
                const now = new Date();
                const key = now.toISOString().split("T")[0] + "_" + now.toTimeString().split(" ")[0].replace(/:/g, "");
                // Only save items that have a count > 0 (shopping cart style)
                const cleanCounts = {};
                Object.entries(counts).forEach(([k, v]) => { if (v && v > 0) cleanCounts[k] = v; });
                // Filter categories to only include items with counts
                const filteredItems = items.map(cat => ({
                    category: cat.category || cat.name || "",
                    items: cat.items.filter(i => cleanCounts[i.id]).map(i => ({ id: i.id, name: i.name, nameEs: i.nameEs || "", supplier: i.supplier || "", orderDay: i.orderDay || "" }))
                })).filter(cat => cat.items.length > 0);
                // Filter countMeta to only include items with counts
                const cleanMeta = {};
                Object.entries(invCountMeta).forEach(([k, v]) => { if (cleanCounts[k]) cleanMeta[k] = v; });
                try {
                    await setDoc(doc(db, "inventoryHistory_" + storeLocation, key), {
                        counts: cleanCounts,
                        items: filteredItems,
                        countMeta: cleanMeta,
                        date: now.toISOString(),
                        listName: "",
                        ordered: {}
                    });
                } catch (err) { console.error("Error saving inventory snapshot:", err); }
            };

            const updateInventoryCount = async (itemId, newCount) => {
                const count = parseInt(newCount) || 0;
                const newInventory = { ...inventory, [itemId]: count };
                setInventory(newInventory);
                const now = new Date();
                const timeStr = now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
                const newMeta = { ...invCountMeta, [itemId]: { by: staffName, at: timeStr } };
                if (count === 0) delete newMeta[itemId];
                setInvCountMeta(newMeta);
                try {
                    await setDoc(doc(db, "ops", "inventory_" + storeLocation), { counts: newInventory, countMeta: newMeta, customInventory, date: new Date().toISOString() });
                } catch (err) { console.error("Error updating inventory:", err); }
            };

            const saveAndResetInventory = async () => {
                setInventorySaving(true);
                try {
                    // Save snapshot to history
                    await saveInventorySnapshot(inventory, customInventory);
                    // Reset all counts to 0
                    const resetCounts = {};
                    customInventory.forEach(cat => {
                        cat.items.forEach(item => { resetCounts[item.id] = 0; });
                    });
                    setInventory(resetCounts);
                    setInvCountMeta({});
                    await setDoc(doc(db, "ops", "inventory_" + storeLocation), { counts: resetCounts, countMeta: {}, customInventory, date: new Date().toISOString() });
                } catch (err) { console.error("Error saving/resetting inventory:", err); }
                setInventorySaving(false);
                setShowSaveConfirm(false);
            };

            const saveInventory = async (counts, items) => {
                try {
                    await setDoc(doc(db, "ops", "inventory_" + storeLocation), {
                        counts, customInventory: items, countMeta: invCountMeta, date: new Date().toISOString()
                    });
                } catch (err) { console.error("Error updating inventory:", err); }
            };

            // Quick write-in add (from the blank line at bottom of each category)
            const quickAddItem = async (catIdx) => {
                const input = (writeInValues[catIdx] || "").trim();
                if (!input) return;
                const translated = autoTranslateItem(input);
                const category = customInventory[catIdx];
                const maxId = Math.max(...category.items.map(item => parseInt(item.id.split('-')[1]) || 0), -1);
                const newItem = { id: catIdx + "-" + (maxId + 1), name: translated.name, nameEs: translated.nameEs, supplier: "", orderDay: "" };
                const updated = customInventory.map((cat, idx) =>
                    idx === catIdx ? { ...cat, items: [...cat.items, newItem] } : cat
                );
                setCustomInventory(updated);
                setWriteInValues(prev => ({ ...prev, [catIdx]: "" }));
                await saveInventory(inventory, updated);
            };

            const addInvItem = async (catIdx) => {
                if (!invNewName.trim()) return;
                const category = customInventory[catIdx];
                const maxId = Math.max(...category.items.map(item => parseInt(item.id.split('-')[1])), -1);
                const newItem = {
                    id: catIdx + "-" + (maxId + 1),
                    name: invNewName.trim(),
                    nameEs: invNewNameEs.trim(),
                    supplier: invNewSupplier.trim(),
                    orderDay: invNewOrderDay
                };
                const updated = customInventory.map((cat, idx) =>
                    idx === catIdx ? { ...cat, items: [...cat.items, newItem] } : cat
                );
                setCustomInventory(updated);
                await saveInventory(inventory, updated);
                setInvNewName(""); setInvNewNameEs(""); setInvNewSupplier(""); setInvNewOrderDay("Fri"); setInvShowAddForm(null);
            };

            const saveInvEdit = async (catIdx, itemIdx) => {
                if (!invEditName.trim()) return;
                const updated = customInventory.map((cat, cIdx) =>
                    cIdx === catIdx
                        ? { ...cat, items: cat.items.map((item, iIdx) =>
                            iIdx === itemIdx
                                ? { ...item, name: invEditName.trim(), nameEs: invEditNameEs.trim(), supplier: invEditSupplier.trim(), orderDay: invEditOrderDay }
                                : item
                            )}
                        : cat
                );
                setCustomInventory(updated);
                await saveInventory(inventory, updated);
                setInvEditingIdx(null); setInvEditName(""); setInvEditNameEs(""); setInvEditSupplier(""); setInvEditOrderDay("Fri");
            };

            const deleteInvItem = async (catIdx, itemIdx) => {
                const updated = customInventory.map((cat, cIdx) =>
                    cIdx === catIdx
                        ? { ...cat, items: cat.items.filter((_, iIdx) => iIdx !== itemIdx) }
                        : cat
                );
                setCustomInventory(updated);
                await saveInventory(inventory, updated);
            };

            // Get tasks for current side + period
            const getCurrentTasks = () => {
                return (customTasks[checklistSide] && customTasks[checklistSide][activePeriod]) || [];
            };

            // Count all checkable items (tasks + subtasks) for completion stats
            const countTaskItems = (task, prefix) => {
                const p = prefix || currentPrefix;
                let total = 0, done = 0;
                if (task.subtasks && task.subtasks.length > 0) {
                    total += task.subtasks.length;
                    done += task.subtasks.filter(s => checks[p + s.id]).length;
                } else {
                    total += 1;
                    done += checks[p + task.id] ? 1 : 0;
                }
                if (task.requirePhoto) {
                    total += 1;
                    done += checks[p + task.id + "_photo"] ? 1 : 0;
                }
                return { total, done };
            };

            const getCompletionStats = (side, listIdx) => {
                const li = listIdx !== undefined ? listIdx : activeListIdx;
                const prefix = getCheckPrefix(side, li);
                let total = 0, done = 0;
                TIME_PERIODS.forEach(p => {
                    const tasks = (customTasks[side] && customTasks[side][p.id]) || [];
                    tasks.forEach(t => { const c = countTaskItems(t, prefix); total += c.total; done += c.done; });
                });
                return { total, done };
            };

            const getPeriodStats = (side, periodId, listIdx) => {
                const li = listIdx !== undefined ? listIdx : activeListIdx;
                const prefix = getCheckPrefix(side, li);
                const tasks = (customTasks[side] && customTasks[side][periodId]) || [];
                let total = 0, done = 0;
                tasks.forEach(t => { const c = countTaskItems(t, prefix); total += c.total; done += c.done; });
                return { total, done };
            };

            // Check if a task is fully complete (all subtasks + photo if required)
            const isTaskComplete = (task) => {
                const p = currentPrefix;
                if (task.subtasks && task.subtasks.length > 0) {
                    if (!task.subtasks.every(s => checks[p + s.id])) return false;
                } else {
                    if (!checks[p + task.id]) return false;
                }
                if (task.requirePhoto && !checks[p + task.id + "_photo"]) return false;
                return true;
            };

            if (!passwordEntered) {
                return (
                    <div className="flex flex-col items-center justify-center min-h-screen bg-gradient-to-b from-mint-50 to-white p-4">
                        <div className="bg-white rounded-lg border-2 border-mint-700 p-8 w-full max-w-sm">
                            <h2 className="text-2xl font-bold text-mint-700 mb-2">ð {t("dailyOps", language)}</h2>
                            <p className="text-gray-600 mb-6">{t("passwordProtected", language)}</p>
                            <form onSubmit={handlePasswordSubmit}>
                                <input type="password" placeholder={t("enterPassword", language)} value={password}
                                    onChange={(e) => setPassword(e.target.value)}
                                    className="w-full px-4 py-2 border-2 border-gray-300 rounded-lg focus:outline-none focus:border-mint-700 mb-4" />
                                <button type="submit" className="w-full bg-mint-700 text-white font-bold py-2 rounded-lg hover:bg-mint-800 transition">
                                    {t("unlock", language)}
                                </button>
                            </form>
                        </div>
                    </div>
                );
            }

            const renderChecklist = () => {
                const tasks = getCurrentTasks();
                const periodStats = getPeriodStats(checklistSide, activePeriod);
                const overallStats = getCompletionStats(checklistSide);
                const sideLists = (checklistLists[checklistSide] || [{ id: checklistSide + "_0", assignee: "" }]);
                const currentAssignKey = activeListIdx === 0 ? checklistSide + "_all" : checklistSide + "_L" + activeListIdx + "_all";
                const currentAssignee = checklistAssignments[currentAssignKey] || (sideLists[activeListIdx] || {}).assignee || "";

                return (
                    <div className="space-y-3">
                        {/* FOH / BOH side selector */}
                        <div className="flex gap-2 mb-1">
                            {["FOH", "BOH"].map(side => {
                                const isActive = checklistSide === side;
                                const color = side === "FOH" ? "blue" : "amber";
                                return (
                                    <button key={side} onClick={() => { setChecklistSide(side); setActiveListIdx(0); setEditMode(false); setEditingIdx(null); setShowAddForm(false); }}
                                        className={`flex-1 py-2 px-2 rounded-xl font-bold text-sm transition border-2 ${isActive ? "bg-" + color + "-600 text-white border-" + color + "-600" : "bg-" + color + "-50 text-" + color + "-700 border-" + color + "-200"}`}>
                                        {side}
                                    </button>
                                );
                            })}
                        </div>

                        {/* Multi-list tabs for current side */}
                        <div className="flex flex-wrap gap-1.5 mb-2">
                            {sideLists.map((listItem, li) => {
                                const liStats = getCompletionStats(checklistSide, li);
                                const listAssignKey = li === 0 ? checklistSide + "_all" : checklistSide + "_L" + li + "_all";
                                const assignee = checklistAssignments[listAssignKey] || listItem.assignee || "";
                                const isActive = activeListIdx === li;
                                const color = checklistSide === "FOH" ? "blue" : "amber";
                                return (
                                    <button key={li} onClick={() => { setActiveListIdx(li); setEditMode(false); setEditingIdx(null); setShowAddForm(false); }}
                                        className={`py-1.5 px-3 rounded-lg font-bold text-xs transition border-2 relative ${isActive ? "bg-" + color + "-100 text-" + color + "-800 border-" + color + "-400" : "bg-gray-50 text-gray-600 border-gray-200 hover:bg-gray-100"}`}>
                                        <div>{assignee || (language === "es" ? "Lista" : "List") + " " + (li + 1)}</div>
                                        <div className="text-[10px] opacity-60">{liStats.done}/{liStats.total}</div>
                                        {currentIsAdmin && isActive && li > 0 && (
                                            <span onClick={(e) => { e.stopPropagation(); if (confirm(language === "es" ? "Â¿Eliminar esta lista?" : "Remove this list?")) removeChecklistList(checklistSide, li); }}
                                                className="absolute -top-1.5 -right-1.5 bg-red-500 text-white rounded-full w-4 h-4 flex items-center justify-center text-[10px] font-bold cursor-pointer hover:bg-red-600">Ã</span>
                                        )}
                                    </button>
                                );
                            })}
                            {currentIsAdmin && (
                                <button onClick={() => addChecklistList(checklistSide)}
                                    className="py-1.5 px-3 rounded-lg text-xs font-bold border-2 border-dashed border-gray-300 text-gray-400 hover:border-gray-400 hover:text-gray-600 transition">
                                    + {language === "es" ? "Lista" : "List"}
                                </button>
                            )}
                        </div>

                        {/* Admin assign dropdown */}
                        {currentIsAdmin && (
                            <div className="flex items-center gap-2 mb-2 bg-gray-50 rounded-lg p-2">
                                <span className="text-xs font-bold text-gray-500">ð¤ {language === "es" ? "Asignar" : "Assign"}:</span>
                                <select
                                    value={currentAssignee}
                                    onChange={e => assignChecklist(checklistSide, "all", e.target.value, activeListIdx)}
                                    className="flex-1 border border-gray-200 rounded-lg px-2 py-1.5 text-xs font-bold bg-white">
                                    <option value="">{language === "es" ? "â Sin asignar â" : "â Unassigned â"}</option>
                                    {(staffList || []).filter(s => s.location === storeLocation || s.location === "both").map(s => (
                                        <option key={s.id} value={s.name}>{s.name}</option>
                                    ))}
                                </select>
                            </div>
                        )}

                        {/* Non-admin sees assignment badge */}
                        {!currentIsAdmin && currentAssignee && currentAssignee === staffName && (
                            <div className="text-center text-xs font-bold py-1.5 rounded-lg mb-2 bg-green-50 text-green-700 border border-green-200">
                                {language === "es" ? "â Asignado a ti" : "â Assigned to you"}
                            </div>
                        )}

                        {/* Overall progress bar */}
                        <div className="bg-gray-100 rounded-lg p-3 mb-2">
                            <div className="flex justify-between text-xs font-bold text-gray-600 mb-1">
                                <span>{checklistSide} â {language === "es" ? "Progreso del dÃ­a" : "Day progress"}</span>
                                <span>{overallStats.done}/{overallStats.total}</span>
                            </div>
                            <div className="w-full bg-gray-200 rounded-full h-2">
                                <div className={`h-2 rounded-full transition-all ${checklistSide === "FOH" ? "bg-blue-500" : "bg-amber-500"}`}
                                    style={{ width: overallStats.total > 0 ? (overallStats.done / overallStats.total * 100) + "%" : "0%" }} />
                            </div>
                        </div>

                        {/* Edit button */}
                        <div className="flex justify-end items-center mt-1">
                            {currentIsAdmin && (
                                <button onClick={() => { setEditMode(!editMode); setEditingIdx(null); setShowAddForm(false); }}
                                    className={"px-3 py-1.5 rounded-lg text-xs font-bold transition " + (editMode ? "bg-mint-100 text-mint-700 border border-mint-200" : "bg-gray-100 text-gray-600 hover:bg-gray-200")}>
                                    {editMode ? (language === "es" ? "Listo" : "Done") : "âï¸ " + (language === "es" ? "Editar" : "Edit")}
                                </button>
                            )}
                        </div>

                        {/* Task list */}
                        {tasks.length === 0 && !editMode && (
                            <div className="text-center py-6 text-gray-400 text-sm">
                                {language === "es" ? "No hay tareas para este perÃ­odo" : "No tasks for this period"}
                            </div>
                        )}

                        {tasks.map((item, idx) => {
                            const hasSubtasks = item.subtasks && item.subtasks.length > 0;
                            const taskComplete = isTaskComplete(item);
                            const photoUrl = checks[currentPrefix + item.id + "_photo"];
                            const photoNeeded = item.requirePhoto && !photoUrl;

                            // Compute urgency for flashing: "warning" (30 min before), "overdue" (past time)
                            let taskUrgency = null;
                            if (item.completeBy && !taskComplete) {
                                const now = new Date();
                                const curMin = now.getHours() * 60 + now.getMinutes();
                                const [dh, dm] = item.completeBy.split(":").map(Number);
                                const deadMin = dh * 60 + dm;
                                if (curMin >= deadMin) taskUrgency = "overdue";
                                else if (curMin >= deadMin - 30) taskUrgency = "warning";
                            }

                            if (editingIdx === idx) {
                                return (
                                    <div key={item.id} className="p-3 rounded-lg border-2 border-blue-300 bg-blue-50">
                                        <input type="text" value={editTask} onChange={e => setEditTask(e.target.value)}
                                            className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm mb-2 focus:outline-none focus:border-blue-400" autoFocus />
                                        {/* Complete by time */}
                                        <div className="flex items-center gap-2 mb-2">
                                            <label className="text-xs font-bold text-gray-600">â° {language === "es" ? "Completar antes de:" : "Complete by:"}</label>
                                            <input type="time" value={editCompleteBy} onChange={e => setEditCompleteBy(e.target.value)}
                                                className="border border-gray-200 rounded px-2 py-1 text-xs" />
                                            {editCompleteBy && <button onClick={() => setEditCompleteBy("")} className="text-red-400 text-xs">â</button>}
                                        </div>
                                        {/* Notify / assign to */}
                                        {editCompleteBy && (
                                            <div className="flex items-center gap-2 mb-2">
                                                <label className="text-xs font-bold text-gray-600">ð {language === "es" ? "Notificar a:" : "Notify:"}</label>
                                                <select value={editAssignTo} onChange={e => setEditAssignTo(e.target.value)}
                                                    className="border border-gray-200 rounded px-2 py-1 text-xs flex-1">
                                                    <option value="">{language === "es" ? "â Nadie â" : "â Nobody â"}</option>
                                                    {(staffList || []).map(s => (
                                                        <option key={s.id} value={s.name}>{s.name}</option>
                                                    ))}
                                                </select>
                                                {editAssignTo && <button onClick={() => setEditAssignTo("")} className="text-red-400 text-xs">â</button>}
                                            </div>
                                        )}
                                        {/* Photo toggle */}
                                        <label className="flex items-center gap-2 mb-2 text-xs cursor-pointer">
                                            <input type="checkbox" checked={editRequirePhoto} onChange={e => setEditRequirePhoto(e.target.checked)} className="w-4 h-4" />
                                            <span className="font-bold text-gray-600">ð¸ {language === "es" ? "Requiere foto" : "Require photo"}</span>
                                        </label>
                                        {/* Subtasks editor */}
                                        <div className="mb-2">
                                            <p className="text-xs font-bold text-gray-500 mb-1">{language === "es" ? "Subtareas" : "Subtasks"}</p>
                                            {editSubtasks.map((sub, si) => (
                                                <div key={si} className="flex gap-1 mb-1">
                                                    <input className="flex-1 border border-gray-200 rounded px-2 py-1 text-xs" value={sub.task}
                                                        onChange={e => { const u = [...editSubtasks]; u[si] = {...u[si], task: e.target.value}; setEditSubtasks(u); }}
                                                        placeholder={(language === "es" ? "Subtarea " : "Subtask ") + (si+1)} />
                                                    <button onClick={() => setEditSubtasks(editSubtasks.filter((_,i) => i !== si))} className="text-red-400 text-xs px-1">â</button>
                                                </div>
                                            ))}
                                            <button onClick={() => setEditSubtasks([...editSubtasks, {id: "", task: ""}])}
                                                className="text-xs text-mint-700 font-bold">+ {language === "es" ? "Agregar subtarea" : "Add subtask"}</button>
                                        </div>
                                        {/* Follow-up question editor */}
                                        <div className="mb-2 border-t border-gray-200 pt-2">
                                            <div className="flex items-center justify-between mb-1">
                                                <p className="text-xs font-bold text-gray-500">â {language === "es" ? "Pregunta al completar" : "Follow-up question"}</p>
                                                {!editFollowUp ? (
                                                    <button onClick={() => setEditFollowUp({ type: "dropdown", question: "", options: [""] })}
                                                        className="text-xs text-blue-600 font-bold">+ {language === "es" ? "Agregar" : "Add"}</button>
                                                ) : (
                                                    <button onClick={() => setEditFollowUp(null)} className="text-red-400 text-xs">â {language === "es" ? "Quitar" : "Remove"}</button>
                                                )}
                                            </div>
                                            {editFollowUp && (
                                                <div className="space-y-2 bg-blue-50 p-2 rounded border border-blue-200">
                                                    <input type="text" value={editFollowUp.question} onChange={e => setEditFollowUp({...editFollowUp, question: e.target.value})}
                                                        placeholder={language === "es" ? "Escribe la pregunta..." : "Type your question..."}
                                                        className="w-full px-2 py-1.5 border border-gray-200 rounded text-xs focus:outline-none focus:border-blue-400" />
                                                    <div className="flex gap-2">
                                                        <button onClick={() => setEditFollowUp({...editFollowUp, type: "dropdown", options: editFollowUp.options?.length ? editFollowUp.options : [""]})}
                                                            className={`flex-1 py-1 rounded text-xs font-bold ${editFollowUp.type === "dropdown" ? "bg-blue-600 text-white" : "bg-white text-gray-600 border"}`}>
                                                            {language === "es" ? "Opciones" : "Choices"}
                                                        </button>
                                                        <button onClick={() => setEditFollowUp({...editFollowUp, type: "text"})}
                                                            className={`flex-1 py-1 rounded text-xs font-bold ${editFollowUp.type === "text" ? "bg-blue-600 text-white" : "bg-white text-gray-600 border"}`}>
                                                            {language === "es" ? "Texto libre" : "Text input"}
                                                        </button>
                                                    </div>
                                                    {editFollowUp.type === "dropdown" && (
                                                        <div className="space-y-1">
                                                            {(editFollowUp.options || []).map((opt, oi) => (
                                                                <div key={oi} className="flex gap-1">
                                                                    <input className="flex-1 border border-gray-200 rounded px-2 py-1 text-xs" value={opt}
                                                                        onChange={e => { const u = [...editFollowUp.options]; u[oi] = e.target.value; setEditFollowUp({...editFollowUp, options: u}); }}
                                                                        placeholder={(language === "es" ? "OpciÃ³n " : "Option ") + (oi+1)} />
                                                                    <button onClick={() => { const u = editFollowUp.options.filter((_,i) => i !== oi); setEditFollowUp({...editFollowUp, options: u}); }}
                                                                        className="text-red-400 text-xs px-1">â</button>
                                                                </div>
                                                            ))}
                                                            <button onClick={() => setEditFollowUp({...editFollowUp, options: [...(editFollowUp.options || []), ""]})}
                                                                className="text-xs text-blue-600 font-bold">+ {language === "es" ? "Agregar opciÃ³n" : "Add option"}</button>
                                                        </div>
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <button onClick={() => saveChecklistEdit(idx)}
                                                className="px-3 py-1.5 bg-blue-600 text-white text-xs font-bold rounded-lg">{language === "es" ? "Guardar" : "Save"}</button>
                                            <button onClick={() => { setEditingIdx(null); setEditSubtasks([]); setEditCompleteBy(""); setEditAssignTo(""); setEditFollowUp(null); }}
                                                className="px-3 py-1.5 bg-gray-100 text-gray-600 text-xs font-bold rounded-lg">{language === "es" ? "Cancelar" : "Cancel"}</button>
                                        </div>
                                    </div>
                                );
                            }

                            return (
                                <div key={item.id} className={"rounded-lg border-2 transition overflow-hidden " +
                                    (taskComplete ? "border-green-300 bg-green-50"
                                        : taskUrgency === "overdue" ? "task-flash-red"
                                        : taskUrgency === "warning" ? "task-flash-yellow"
                                        : "border-gray-200 bg-white")}>
                                    <div className="flex items-center gap-1">
                                        <div className={"flex-1 flex items-start p-3 " + (!editMode && !hasSubtasks ? "cursor-pointer" : "")}>
                                            {!editMode && !hasSubtasks && (
                                                <input type="checkbox" checked={checks[currentPrefix + item.id] || false}
                                                    onChange={() => toggleCheckItem(item.id, item)}
                                                    className="w-5 h-5 text-mint-700 rounded focus:ring-2 focus:ring-mint-700 mt-0.5" />
                                            )}
                                            <div className={"flex-1 " + (!editMode && !hasSubtasks ? "ml-3" : "")}>
                                                <div className="flex items-center gap-1.5">
                                                    <p className={"font-bold text-gray-800 " + (taskComplete ? "line-through text-green-700" : "")}>
                                                        {item.task.includes("\n") ? item.task.split("\n").map((line, li) => (
                                                            <span key={li}>{li === 0 ? line : <><br/><span className="font-normal text-xs text-gray-500">{line}</span></>}</span>
                                                        )) : item.task}
                                                    </p>
                                                    {item.requirePhoto && <span className="text-xs">ð¸</span>}
                                                    {item.completeBy && (
                                                        <span className={`text-xs font-bold px-1.5 py-0.5 rounded-full whitespace-nowrap ${
                                                            taskComplete ? "bg-green-100 text-green-600"
                                                            : taskUrgency === "overdue" ? "bg-red-600 text-white"
                                                            : taskUrgency === "warning" ? "bg-yellow-400 text-yellow-900"
                                                            : "bg-orange-100 text-orange-600"
                                                        }`}>
                                                            {taskUrgency === "overdue" ? "ð¨" : "â°"} {item.completeBy.replace(/^0/, "")}
                                                        </span>
                                                    )}
                                                    {item.assignTo && (
                                                        <span className="text-xs font-bold px-1.5 py-0.5 rounded-full whitespace-nowrap bg-blue-100 text-blue-600">
                                                            ð {item.assignTo.split(" ")[0]}
                                                        </span>
                                                    )}
                                                </div>
                                                {/* Completed by info â for tasks without subtasks */}
                                                {!hasSubtasks && checks[currentPrefix + item.id] && checks[currentPrefix + item.id + "_by"] && (
                                                    <p className="text-xs text-green-600 mt-0.5">
                                                        â {checks[currentPrefix + item.id + "_by"]} â {checks[currentPrefix + item.id + "_at"]}
                                                    </p>
                                                )}
                                            </div>
                                        </div>
                                        {editMode && (
                                            <div className="flex flex-col gap-1 pr-2">
                                                <button onClick={() => { setEditingIdx(idx); setEditTask(item.task); setEditRequirePhoto(!!item.requirePhoto); setEditCompleteBy(item.completeBy || ""); setEditAssignTo(item.assignTo || ""); setEditFollowUp(item.followUp ? {...item.followUp, options: item.followUp.options ? [...item.followUp.options] : []} : null); setEditSubtasks(item.subtasks ? item.subtasks.map(s => ({...s})) : []); setShowAddForm(false); }}
                                                    className="p-1.5 rounded-lg bg-blue-50 text-blue-600 hover:bg-blue-100">âï¸</button>
                                                <button onClick={() => deleteChecklistTask(idx)}
                                                    className="p-1.5 rounded-lg bg-red-50 text-red-600 hover:bg-red-100">ðï¸</button>
                                            </div>
                                        )}
                                    </div>

                                    {/* Subtasks */}
                                    {hasSubtasks && !editMode && (
                                        <div className="px-3 pb-2 space-y-1 ml-4 border-t border-gray-100 pt-2">
                                            {item.subtasks.map(sub => (
                                                <div key={sub.id}>
                                                    <label className="flex items-center gap-2 cursor-pointer">
                                                        <input type="checkbox" checked={checks[currentPrefix + sub.id] || false}
                                                            onChange={() => toggleCheckItem(sub.id, item)}
                                                            className="w-4 h-4 text-mint-600 rounded" />
                                                        <span className={"text-sm " + (checks[currentPrefix + sub.id] ? "line-through text-green-600" : "text-gray-700")}>{sub.task}</span>
                                                    </label>
                                                    {checks[currentPrefix + sub.id] && checks[currentPrefix + sub.id + "_by"] && (
                                                        <p className="text-xs text-green-600 ml-6">
                                                            â {checks[currentPrefix + sub.id + "_by"]} â {checks[currentPrefix + sub.id + "_at"]}
                                                        </p>
                                                    )}
                                                </div>
                                            ))}
                                        </div>
                                    )}

                                    {/* Photo capture */}
                                    {item.requirePhoto && !editMode && (
                                        <div className="px-3 pb-3 border-t border-gray-100 pt-2">
                                            {photoUrl ? (
                                                <div>
                                                    <div className="flex items-center gap-2 mb-1">
                                                        <span className="text-xs text-green-600 font-bold">â {language === "es" ? "Foto tomada" : "Photo taken"}</span>
                                                        <span className="text-xs text-gray-400">{checks[currentPrefix + item.id + "_photoTime"] ? new Date(checks[currentPrefix + item.id + "_photoTime"]).toLocaleTimeString() : ""}</span>
                                                    </div>
                                                    <img src={photoUrl} alt="Task photo" className="rounded-lg border border-gray-200 max-w-full cursor-pointer" style={{ maxHeight: "150px" }}
                                                        onClick={() => window.open(photoUrl, "_blank")} />
                                                </div>
                                            ) : (
                                                <div>
                                                    <input type="file" accept="image/*" capture="environment"
                                                        ref={capturingPhoto === item.id ? photoInputRef : null}
                                                        onChange={e => handlePhotoCapture(e, item.id)}
                                                        className="hidden" id={"photo-" + item.id} />
                                                    <button onClick={() => { setCapturingPhoto(item.id); document.getElementById("photo-" + item.id)?.click(); }}
                                                        disabled={capturingPhoto === item.id}
                                                        className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-50 border border-blue-200 rounded-lg text-xs font-bold text-blue-700 hover:bg-blue-100 transition">
                                                        {capturingPhoto === item.id
                                                            ? (language === "es" ? "â³ Subiendo..." : "â³ Uploading...")
                                                            : (language === "es" ? "ð¸ Tomar foto" : "ð¸ Take photo")}
                                                    </button>
                                                </div>
                                            )}
                                        </div>
                                    )}
                                    {/* Follow-up question prompt â shows when task is completed */}
                                    {item.followUp && item.followUp.question && (showFollowUpFor === item.id || (taskComplete && !checks[currentPrefix + item.id + "_followUp"])) && (
                                        <div className="mx-3 mb-3 p-3 bg-blue-50 border-2 border-blue-300 rounded-xl">
                                            <p className="text-sm font-bold text-blue-800 mb-2">â {item.followUp.question}</p>
                                            {item.followUp.type === "dropdown" && item.followUp.options ? (
                                                <div className="space-y-1.5">
                                                    {item.followUp.options.map((opt, oi) => (
                                                        <button key={oi} onClick={() => saveFollowUpAnswer(item.id, opt)}
                                                            className="w-full text-left px-3 py-2 bg-white border border-blue-200 rounded-lg text-sm font-medium hover:bg-blue-100 hover:border-blue-400 transition">
                                                            {opt}
                                                        </button>
                                                    ))}
                                                </div>
                                            ) : (
                                                <div className="flex gap-2">
                                                    <input type="text" value={followUpAnswers[item.id] || ""}
                                                        onChange={e => setFollowUpAnswers(prev => ({...prev, [item.id]: e.target.value}))}
                                                        placeholder={language === "es" ? "Escribe tu respuesta..." : "Type your answer..."}
                                                        className="flex-1 px-3 py-2 border border-blue-200 rounded-lg text-sm focus:outline-none focus:border-blue-500"
                                                        onKeyDown={e => { if (e.key === "Enter" && followUpAnswers[item.id]?.trim()) saveFollowUpAnswer(item.id, followUpAnswers[item.id].trim()); }} />
                                                    <button onClick={() => { if (followUpAnswers[item.id]?.trim()) saveFollowUpAnswer(item.id, followUpAnswers[item.id].trim()); }}
                                                        className="px-3 py-2 bg-blue-600 text-white rounded-lg text-xs font-bold hover:bg-blue-700">
                                                        â
                                                    </button>
                                                </div>
                                            )}
                                        </div>
                                    )}
                                    {/* Show saved answer */}
                                    {item.followUp && checks[currentPrefix + item.id + "_followUp"] && showFollowUpFor !== item.id && (
                                        <div className="mx-3 mb-2 px-3 py-1.5 bg-gray-50 rounded-lg border border-gray-200">
                                            <p className="text-xs text-gray-500">â {item.followUp.question}</p>
                                            <p className="text-sm font-bold text-gray-700">ð¬ {checks[currentPrefix + item.id + "_followUp"]}</p>
                                        </div>
                                    )}
                                </div>
                            );
                        })}

                        {editMode && !showAddForm && (
                            <button onClick={() => { setShowAddForm(true); setEditingIdx(null); }}
                                className="w-full mt-2 p-3 rounded-lg border-2 border-dashed border-gray-300 text-gray-500 text-sm font-bold hover:border-mint-300 hover:text-mint-600 hover:bg-mint-50 transition flex items-center justify-center gap-2">
                                + {language === "es" ? "Agregar tarea" : "Add task"}
                            </button>
                        )}

                        {editMode && showAddForm && (
                            <div className="mt-2 p-3 rounded-lg border-2 border-green-300 bg-green-50">
                                <input type="text" value={newTask} onChange={e => setNewTask(e.target.value)}
                                    placeholder={language === "es" ? "Nueva tarea..." : "New task..."}
                                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm mb-2 focus:outline-none focus:border-green-400" autoFocus />
                                {/* Complete by time */}
                                <div className="flex items-center gap-2 mb-2">
                                    <label className="text-xs font-bold text-gray-600">â° {language === "es" ? "Completar antes de:" : "Complete by:"}</label>
                                    <input type="time" value={newCompleteBy} onChange={e => setNewCompleteBy(e.target.value)}
                                        className="border border-gray-200 rounded px-2 py-1 text-xs" />
                                    {newCompleteBy && <button onClick={() => setNewCompleteBy("")} className="text-red-400 text-xs">â</button>}
                                </div>
                                {/* Notify / assign to */}
                                {newCompleteBy && (
                                    <div className="flex items-center gap-2 mb-2">
                                        <label className="text-xs font-bold text-gray-600">ð {language === "es" ? "Notificar a:" : "Notify:"}</label>
                                        <select value={newAssignTo} onChange={e => setNewAssignTo(e.target.value)}
                                            className="border border-gray-200 rounded px-2 py-1 text-xs flex-1">
                                            <option value="">{language === "es" ? "â Nadie â" : "â Nobody â"}</option>
                                            {(staffList || []).map(s => (
                                                <option key={s.id} value={s.name}>{s.name}</option>
                                            ))}
                                        </select>
                                        {newAssignTo && <button onClick={() => setNewAssignTo("")} className="text-red-400 text-xs">â</button>}
                                    </div>
                                )}
                                {/* Photo toggle */}
                                <label className="flex items-center gap-2 mb-2 text-xs cursor-pointer">
                                    <input type="checkbox" checked={newRequirePhoto} onChange={e => setNewRequirePhoto(e.target.checked)} className="w-4 h-4" />
                                    <span className="font-bold text-gray-600">ð¸ {language === "es" ? "Requiere foto" : "Require photo"}</span>
                                </label>
                                {/* Subtasks editor */}
                                <div className="mb-2">
                                    <p className="text-xs font-bold text-gray-500 mb-1">{language === "es" ? "Subtareas" : "Subtasks"}</p>
                                    {newSubtasks.map((sub, si) => (
                                        <div key={si} className="flex gap-1 mb-1">
                                            <input className="flex-1 border border-gray-200 rounded px-2 py-1 text-xs" value={sub.task}
                                                onChange={e => { const u = [...newSubtasks]; u[si] = {...u[si], task: e.target.value}; setNewSubtasks(u); }}
                                                placeholder={(language === "es" ? "Subtarea " : "Subtask ") + (si+1)} />
                                            <button onClick={() => setNewSubtasks(newSubtasks.filter((_,i) => i !== si))} className="text-red-400 text-xs px-1">â</button>
                                        </div>
                                    ))}
                                    <button onClick={() => setNewSubtasks([...newSubtasks, {id: "", task: ""}])}
                                        className="text-xs text-mint-700 font-bold">+ {language === "es" ? "Agregar subtarea" : "Add subtask"}</button>
                                </div>
                                {/* Follow-up question editor */}
                                <div className="mb-2 border-t border-gray-200 pt-2">
                                    <div className="flex items-center justify-between mb-1">
                                        <p className="text-xs font-bold text-gray-500">â {language === "es" ? "Pregunta al completar" : "Follow-up question"}</p>
                                        {!newFollowUp ? (
                                            <button onClick={() => setNewFollowUp({ type: "dropdown", question: "", options: [""] })}
                                                className="text-xs text-blue-600 font-bold">+ {language === "es" ? "Agregar" : "Add"}</button>
                                        ) : (
                                            <button onClick={() => setNewFollowUp(null)} className="text-red-400 text-xs">â {language === "es" ? "Quitar" : "Remove"}</button>
                                        )}
                                    </div>
                                    {newFollowUp && (
                                        <div className="space-y-2 bg-blue-50 p-2 rounded border border-blue-200">
                                            <input type="text" value={newFollowUp.question} onChange={e => setNewFollowUp({...newFollowUp, question: e.target.value})}
                                                placeholder={language === "es" ? "Escribe la pregunta..." : "Type your question..."}
                                                className="w-full px-2 py-1.5 border border-gray-200 rounded text-xs focus:outline-none focus:border-blue-400" />
                                            <div className="flex gap-2">
                                                <button onClick={() => setNewFollowUp({...newFollowUp, type: "dropdown", options: newFollowUp.options?.length ? newFollowUp.options : [""]})}
                                                    className={`flex-1 py-1 rounded text-xs font-bold ${newFollowUp.type === "dropdown" ? "bg-blue-600 text-white" : "bg-white text-gray-600 border"}`}>
                                                    {language === "es" ? "Opciones" : "Choices"}
                                                </button>
                                                <button onClick={() => setNewFollowUp({...newFollowUp, type: "text"})}
                                                    className={`flex-1 py-1 rounded text-xs font-bold ${newFollowUp.type === "text" ? "bg-blue-600 text-white" : "bg-white text-gray-600 border"}`}>
                                                    {language === "es" ? "Texto libre" : "Text input"}
                                                </button>
                                            </div>
                                            {newFollowUp.type === "dropdown" && (
                                                <div className="space-y-1">
                                                    {(newFollowUp.options || []).map((opt, oi) => (
                                                        <div key={oi} className="flex gap-1">
                                                            <input className="flex-1 border border-gray-200 rounded px-2 py-1 text-xs" value={opt}
                                                                onChange={e => { const u = [...newFollowUp.options]; u[oi] = e.target.value; setNewFollowUp({...newFollowUp, options: u}); }}
                                                                placeholder={(language === "es" ? "OpciÃ³n " : "Option ") + (oi+1)} />
                                                            <button onClick={() => { const u = newFollowUp.options.filter((_,i) => i !== oi); setNewFollowUp({...newFollowUp, options: u}); }}
                                                                className="text-red-400 text-xs px-1">â</button>
                                                        </div>
                                                    ))}
                                                    <button onClick={() => setNewFollowUp({...newFollowUp, options: [...(newFollowUp.options || []), ""]})}
                                                        className="text-xs text-blue-600 font-bold">+ {language === "es" ? "Agregar opciÃ³n" : "Add option"}</button>
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </div>
                                <div className="flex items-center gap-2">
                                    <button onClick={addChecklistTask}
                                        className="px-3 py-1.5 bg-green-600 text-white text-xs font-bold rounded-lg">{language === "es" ? "Agregar" : "Add"}</button>
                                    <button onClick={() => { setShowAddForm(false); setNewTask(""); setNewRequirePhoto(false); setNewSubtasks([]); setNewCompleteBy(""); setNewAssignTo(""); setNewFollowUp(null); }}
                                        className="px-3 py-1.5 bg-gray-100 text-gray-600 text-xs font-bold rounded-lg">{language === "es" ? "Cancelar" : "Cancel"}</button>
                                </div>
                            </div>
                        )}

                        {/* Reset button â admin only */}
                        {currentIsAdmin && (
                            <button onClick={resetAllChecklists}
                                className="w-full mt-4 py-3 rounded-xl font-bold text-sm bg-red-50 text-red-600 border-2 border-red-200 hover:bg-red-100 transition">
                                {language === "es" ? "ð¾ Guardar y Reiniciar Checklists" : "ð¾ Save & Reset Checklists"}
                            </button>
                        )}
                    </div>
                );
            };

            return (
                <div className="p-4 pb-24">
                    <h2 className="text-2xl font-bold text-mint-700 mb-4">ð {t("dailyOps", language)}</h2>

                    <div className="flex gap-2 mb-6">
                        <button onClick={() => { setActiveTab("checklist"); setEditMode(false); setEditingIdx(null); setShowAddForm(false); }}
                            className={`flex-1 py-2 rounded-lg font-bold transition ${activeTab === "checklist" ? "bg-mint-700 text-white" : "bg-gray-200 text-gray-700"}`}>
                            {language === "es" ? "Tareas" : "Tasks"}
                        </button>
                        <button onClick={() => { setActiveTab("inventory"); setEditMode(false); }}
                            className={`flex-1 py-2 rounded-lg font-bold transition ${activeTab === "inventory" ? "bg-mint-700 text-white" : "bg-gray-200 text-gray-700"}`}>
                            {t("inventory", language)}
                        </button>
                        <button onClick={() => { setActiveTab("breaks"); setEditMode(false); }}
                            className={`flex-1 py-2 rounded-lg font-bold transition ${activeTab === "breaks" ? "bg-mint-700 text-white" : "bg-gray-200 text-gray-700"}`}>
                            Breaks
                        </button>
                    </div>

                    {/* ââ TASK DEADLINE ALERTS ââ */}
                    {activeAlerts.length > 0 && (
                        <div className="space-y-2 mb-3">
                            {activeAlerts.map(a => (
                                <div key={a.key} className={`flex items-center gap-2 px-3 py-2.5 rounded-xl border-2 shadow-sm animate-pulse ${
                                    a.type === "overdue" ? "bg-red-50 border-red-300" : "bg-yellow-50 border-yellow-300"
                                }`}>
                                    <span className="text-xl">{a.type === "overdue" ? "ð¨" : "â°"}</span>
                                    <div className="flex-1 min-w-0">
                                        <p className={`text-sm font-bold ${a.type === "overdue" ? "text-red-700" : "text-yellow-800"}`}>
                                            {a.taskName}
                                        </p>
                                        <p className={`text-xs ${a.type === "overdue" ? "text-red-500" : "text-yellow-600"}`}>
                                            {a.type === "overdue"
                                                ? (language === "es" ? `VenciÃ³ a las ${a.timeStr} â ${a.message}` : `Due at ${a.timeStr} â ${a.message}`)
                                                : (language === "es" ? `Vence a las ${a.timeStr} â ${a.message}` : `Due at ${a.timeStr} â ${a.message}`)
                                            }
                                        </p>
                                    </div>
                                    <button onClick={() => dismissAlert(a.key)}
                                        className={`text-xs font-bold px-2 py-1 rounded-lg ${a.type === "overdue" ? "bg-red-200 text-red-700" : "bg-yellow-200 text-yellow-700"}`}>
                                        â
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}

                    {activeTab === "checklist" && renderChecklist()}

                    {activeTab === "inventory" && (
                        <div className="space-y-4">
                            <div className="flex justify-between items-center">
                                {lastUpdated.inventory && <p className="text-xs text-gray-500">{t("lastUpdated", language)}: {lastUpdated.inventory}</p>}
                                <button onClick={() => { setInvEditMode(!invEditMode); setInvEditingIdx(null); setInvShowAddForm(null); }}
                                    className={`px-4 py-2 rounded-lg font-bold transition ${invEditMode ? "bg-green-700 text-white" : "bg-blue-700 text-white"}`}>
                                    {invEditMode ? (language === "es" ? "Listo" : "Done Editing") : (language === "es" ? "Editar" : "Edit")}
                                </button>
                            </div>

                            {/* Search bar */}
                            {!invEditMode && (
                                <div className="relative">
                                    <input type="text" value={invSearch} onChange={e => setInvSearch(e.target.value)}
                                        placeholder={language === "es" ? "ð Buscar artÃ­culo..." : "ð Search items..."}
                                        className="w-full px-4 py-2.5 border-2 border-gray-200 rounded-xl text-sm focus:outline-none focus:border-mint-700 bg-white" />
                                    {invSearch && (
                                        <button onClick={() => setInvSearch("")}
                                            className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-lg">â</button>
                                    )}
                                </div>
                            )}

                            {/* Cart summary â items with counts */}
                            {!invEditMode && (() => {
                                const itemCount = Object.values(inventory).filter(v => v > 0).length;
                                const totalQty = Object.values(inventory).reduce((sum, v) => sum + (v > 0 ? v : 0), 0);
                                if (itemCount === 0) return null;
                                return (
                                    <div className="bg-mint-50 border border-mint-200 rounded-xl px-3 py-2 flex items-center justify-between">
                                        <span className="text-sm font-bold text-mint-700">
                                            ð {totalQty} {language === "es" ? "total" : "total"} ({itemCount} {language === "es" ? "artÃ­culos" : "items"})
                                        </span>
                                        <span className="text-xs text-mint-600">
                                            {language === "es" ? "Solo estos se guardarÃ¡n" : "Only these will be saved"}
                                        </span>
                                    </div>
                                );
                            })()}

                            {customInventory.map((category, catIdx) => {
                                // Filter items by search
                                const searchLower = invSearch.toLowerCase().trim();
                                const filteredItems = searchLower
                                    ? category.items.filter(item =>
                                        (item.name || "").toLowerCase().includes(searchLower) ||
                                        (item.nameEs || "").toLowerCase().includes(searchLower) ||
                                        (item.supplier || "").toLowerCase().includes(searchLower)
                                    )
                                    : category.items;
                                // Hide empty categories when searching
                                if (searchLower && filteredItems.length === 0) return null;
                                return (
                                <div key={category.id} className="bg-white rounded-lg border-2 border-gray-200 overflow-hidden">
                                    <div className="p-3 bg-mint-50 border-b font-bold text-mint-700 flex justify-between items-center">
                                        <span>{language === "es" ? category.nameEs : category.name}</span>
                                        {!invEditMode && <span className="text-xs font-normal text-gray-500">{filteredItems.length} {language === "es" ? "artÃ­culos" : "items"}</span>}
                                    </div>
                                    <div className="p-3 space-y-2">
                                        {filteredItems.map((item) => {
                                            const itemIdx = category.items.indexOf(item);
                                            const isEditing = invEditMode && invEditingIdx && invEditingIdx.catIdx === catIdx && invEditingIdx.itemIdx === itemIdx;
                                            return (
                                                <div key={item.id} className={`p-2 rounded border ${isEditing ? "border-blue-500 bg-blue-50" : "border-transparent"}`}>
                                                    {isEditing ? (
                                                        <div className="space-y-2">
                                                            <input type="text" value={invEditName} onChange={(e) => setInvEditName(e.target.value)}
                                                                placeholder={language === "es" ? "Nombre del artÃ­culo" : "Item name"} className="w-full px-2 py-1 border-2 border-gray-300 rounded focus:border-mint-700 focus:outline-none" />
                                                            <input type="text" value={invEditNameEs} onChange={(e) => setInvEditNameEs(e.target.value)}
                                                                placeholder={language === "es" ? "Nombre en espaÃ±ol" : "Name in Spanish"} className="w-full px-2 py-1 border-2 border-gray-300 rounded focus:border-mint-700 focus:outline-none" />
                                                            <input type="text" value={invEditSupplier} onChange={(e) => setInvEditSupplier(e.target.value)}
                                                                placeholder={language === "es" ? "Proveedor" : "Supplier"} className="w-full px-2 py-1 border-2 border-gray-300 rounded focus:border-mint-700 focus:outline-none" />
                                                            <input type="text" value={invEditOrderDay} onChange={(e) => setInvEditOrderDay(e.target.value)}
                                                                placeholder={language === "es" ? "DÃ­a de pedido" : "Order day"} className="w-full px-2 py-1 border-2 border-gray-300 rounded focus:border-mint-700 focus:outline-none" />
                                                            <div className="flex gap-2">
                                                                <button onClick={() => saveInvEdit(catIdx, itemIdx)} className="flex-1 bg-green-700 text-white py-1 rounded hover:bg-green-800">{language === "es" ? "Guardar" : "Save"}</button>
                                                                <button onClick={() => setInvEditingIdx(null)} className="flex-1 bg-gray-500 text-white py-1 rounded hover:bg-gray-600">{language === "es" ? "Cancelar" : "Cancel"}</button>
                                                            </div>
                                                        </div>
                                                    ) : (
                                                        <div className="flex items-center justify-between text-sm">
                                                            <div className="flex-1">
                                                                <p className="font-semibold text-gray-800">{language === "es" && item.nameEs ? item.nameEs : item.name}</p>
                                                                {language === "es" && item.nameEs && <p className="text-xs text-gray-400 italic">{item.name}</p>}
                                                                {language !== "es" && item.nameEs && <p className="text-xs text-gray-400 italic">{item.nameEs}</p>}
                                                                <p className="text-xs text-gray-500">{t("supplier", language)}: {item.supplier}</p>
                                                                {invCountMeta[item.id] && (inventory[item.id] || 0) > 0 && (
                                                                    <p className="text-xs text-mint-600">â {invCountMeta[item.id].by} â {invCountMeta[item.id].at}</p>
                                                                )}
                                                            </div>
                                                            <div className="flex items-center gap-2">
                                                                {invEditMode ? (
                                                                    <>
                                                                        <button onClick={() => {
                                                                            setInvEditingIdx({catIdx, itemIdx});
                                                                            setInvEditName(item.name);
                                                                            setInvEditNameEs(item.nameEs || "");
                                                                            setInvEditSupplier(item.supplier);
                                                                            setInvEditOrderDay(item.orderDay);
                                                                        }} className="text-xl hover:text-blue-700">âï¸</button>
                                                                        <button onClick={() => deleteInvItem(catIdx, itemIdx)} className="text-xl hover:text-red-700">ðï¸</button>
                                                                    </>
                                                                ) : (
                                                                    <div className="flex items-center gap-1">
                                                                        <button onClick={() => updateInventoryCount(item.id, Math.max(0, (inventory[item.id] || 0) - 1))}
                                                                            className="w-9 h-9 rounded-lg bg-gray-200 text-gray-700 font-bold text-xl flex items-center justify-center hover:bg-red-100 active:bg-red-200 transition">â</button>
                                                                        <span className="w-10 text-center font-bold text-lg">{inventory[item.id] || 0}</span>
                                                                        <button onClick={() => updateInventoryCount(item.id, (inventory[item.id] || 0) + 1)}
                                                                            className="w-9 h-9 rounded-lg bg-gray-200 text-gray-700 font-bold text-xl flex items-center justify-center hover:bg-green-100 active:bg-green-200 transition">+</button>
                                                                    </div>
                                                                )}
                                                            </div>
                                                        </div>
                                                    )}
                                                </div>
                                            );
                                        })}
                                        {/* Write-in line â always visible when not in edit mode */}
                                        {!invEditMode && (
                                            <div className="p-2 border-t border-dashed border-gray-200">
                                                <div className="flex items-center gap-2">
                                                    <input type="text"
                                                        value={writeInValues[catIdx] || ""}
                                                        onChange={e => setWriteInValues(prev => ({ ...prev, [catIdx]: e.target.value }))}
                                                        onKeyDown={e => { if (e.key === "Enter") quickAddItem(catIdx); }}
                                                        placeholder={language === "es" ? "âï¸ Escribir artÃ­culo..." : "âï¸ Write in item..."}
                                                        className="flex-1 px-2 py-1.5 border border-gray-200 rounded-lg text-sm bg-gray-50 focus:outline-none focus:border-mint-500 focus:bg-white" />
                                                    {(writeInValues[catIdx] || "").trim() && (
                                                        <button onClick={() => quickAddItem(catIdx)}
                                                            className="px-3 py-1.5 bg-mint-600 text-white rounded-lg text-xs font-bold hover:bg-mint-700 active:scale-95 transition">
                                                            {language === "es" ? "Agregar" : "Add"}
                                                        </button>
                                                    )}
                                                </div>
                                            </div>
                                        )}
                                        {invEditMode && invShowAddForm === catIdx ? (
                                            <div className="p-2 border-2 border-green-500 rounded bg-green-50 space-y-2">
                                                <input type="text" value={invNewName} onChange={(e) => setInvNewName(e.target.value)}
                                                    placeholder={language === "es" ? "Nombre del artÃ­culo" : "New item name"} className="w-full px-2 py-1 border-2 border-gray-300 rounded focus:border-mint-700 focus:outline-none" />
                                                <input type="text" value={invNewNameEs} onChange={(e) => setInvNewNameEs(e.target.value)}
                                                    placeholder={language === "es" ? "Nombre en espaÃ±ol" : "Name in Spanish"} className="w-full px-2 py-1 border-2 border-gray-300 rounded focus:border-mint-700 focus:outline-none" />
                                                <input type="text" value={invNewSupplier} onChange={(e) => setInvNewSupplier(e.target.value)}
                                                    placeholder={language === "es" ? "Proveedor" : "Supplier"} className="w-full px-2 py-1 border-2 border-gray-300 rounded focus:border-mint-700 focus:outline-none" />
                                                <input type="text" value={invNewOrderDay} onChange={(e) => setInvNewOrderDay(e.target.value)}
                                                    placeholder={language === "es" ? "DÃ­a de pedido" : "Order day"} className="w-full px-2 py-1 border-2 border-gray-300 rounded focus:border-mint-700 focus:outline-none" />
                                                <div className="flex gap-2">
                                                    <button onClick={() => addInvItem(catIdx)} className="flex-1 bg-green-700 text-white py-1 rounded hover:bg-green-800">{language === "es" ? "Agregar" : "Add"}</button>
                                                    <button onClick={() => setInvShowAddForm(null)} className="flex-1 bg-gray-500 text-white py-1 rounded hover:bg-gray-600">{language === "es" ? "Cancelar" : "Cancel"}</button>
                                                </div>
                                            </div>
                                        ) : invEditMode && (
                                            <button onClick={() => setInvShowAddForm(catIdx)} className="w-full py-2 text-green-700 font-bold border-2 border-green-700 rounded hover:bg-green-50">{language === "es" ? "+ Agregar ArtÃ­culo" : "+ Add Item"}</button>
                                        )}
                                    </div>
                                </div>
                            ); })}

                            {/* Save & Reset Button + Confirmation */}
                            {!invEditMode && (
                                <div className="sticky bottom-20 pt-3">
                                    {showSaveConfirm ? (
                                        <div className="bg-white border-2 border-mint-700 rounded-xl p-4 shadow-xl">
                                            <p className="text-center text-lg font-bold text-gray-800 mb-4">
                                                {language === "es" ? "Â¿Ya REVISASTE?" : "Did you LOOK?"}
                                            </p>
                                            <div className="flex gap-3">
                                                <button
                                                    onClick={saveAndResetInventory}
                                                    disabled={inventorySaving}
                                                    className="flex-1 py-3 rounded-xl font-bold text-lg bg-mint-700 text-white hover:bg-mint-800 active:scale-95 transition"
                                                >
                                                    {inventorySaving
                                                        ? (language === "es" ? "Guardando..." : "Saving...")
                                                        : (language === "es" ? "â SÃ­" : "â Yes")}
                                                </button>
                                                <button
                                                    onClick={() => setShowSaveConfirm(false)}
                                                    disabled={inventorySaving}
                                                    className="flex-1 py-3 rounded-xl font-bold text-lg bg-gray-200 text-gray-700 hover:bg-gray-300 transition"
                                                >
                                                    {language === "es" ? "Cancelar" : "Cancel"}
                                                </button>
                                            </div>
                                        </div>
                                    ) : (
                                        <button
                                            onClick={() => setShowSaveConfirm(true)}
                                            className="w-full py-4 rounded-xl font-bold text-lg shadow-lg bg-mint-700 text-white hover:bg-mint-800 active:scale-95 transition"
                                        >
                                            {language === "es" ? "ð¾ Guardar y Reiniciar Conteos" : "ð¾ Save & Reset Counts"}
                                        </button>
                                    )}
                                </div>
                            )}

                            {/* ââ SAVED INVENTORY LISTS ââ */}
                            <div className="mt-6 pt-4 border-t-2 border-gray-200">
                                <h3 className="text-lg font-bold text-mint-700 mb-1">ð¦ {language === "es" ? "Listas Guardadas" : "Saved Lists"}</h3>
                                <p className="text-xs text-gray-500 mb-3">{language === "es"
                                    ? "Revisa conteos anteriores, marca lo que ya se pidiÃ³."
                                    : "Review past counts, check off what's been ordered."}</p>
                                <InventoryHistory language={language} customInventory={customInventory} storeLocation={storeLocation} />
                            </div>
                        </div>
                    )}

                    {activeTab === "breaks" && (
                        <div className="space-y-4">
                            {/* Date picker */}
                            <div className="flex items-center gap-2">
                                <button onClick={() => {
                                    const d = new Date(breakDate + "T12:00:00");
                                    d.setDate(d.getDate() - 1);
                                    setBreakDate(d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0") + "-" + String(d.getDate()).padStart(2,"0"));
                                }} className="w-9 h-9 rounded-lg bg-gray-200 text-gray-600 font-bold text-lg flex items-center justify-center hover:bg-gray-300">â</button>
                                <div className="flex-1 text-center">
                                    <input type="date" value={breakDate} onChange={e => setBreakDate(e.target.value)}
                                        className="bg-transparent text-center font-bold text-gray-800 border-none text-sm focus:outline-none" />
                                    <div className="text-xs text-gray-500">
                                        {(() => {
                                            const d = new Date(breakDate + "T12:00:00");
                                            const today = getTodayKey();
                                            const tomorrow = (() => { const t = new Date(); t.setDate(t.getDate()+1); return t.getFullYear()+"-"+String(t.getMonth()+1).padStart(2,"0")+"-"+String(t.getDate()).padStart(2,"0"); })();
                                            if (breakDate === today) return language === "es" ? "ð Hoy" : "ð Today";
                                            if (breakDate === tomorrow) return language === "es" ? "ð MaÃ±ana" : "ð Tomorrow";
                                            return d.toLocaleDateString(language === "es" ? "es-US" : "en-US", { weekday: "long" });
                                        })()}
                                    </div>
                                </div>
                                <button onClick={() => {
                                    const d = new Date(breakDate + "T12:00:00");
                                    d.setDate(d.getDate() + 1);
                                    setBreakDate(d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0") + "-" + String(d.getDate()).padStart(2,"0"));
                                }} className="w-9 h-9 rounded-lg bg-gray-200 text-gray-600 font-bold text-lg flex items-center justify-center hover:bg-gray-300">â</button>
                                {breakDate !== getTodayKey() && (
                                    <button onClick={() => setBreakDate(getTodayKey())}
                                        className="text-xs font-bold text-mint-700 bg-mint-50 border border-mint-200 px-2 py-1 rounded-lg">
                                        {language === "es" ? "Hoy" : "Today"}
                                    </button>
                                )}
                            </div>

                            <div className="flex items-center justify-between">
                                <p className="text-sm text-gray-600">
                                    {language === "es" ? "Asigna estaciones y planifica los breaks" : "Assign stations & plan breaks"}
                                </p>
                                <div className="flex gap-2">
                                    <button onClick={() => setShowMatrix(!showMatrix)} className={`text-xs underline ${showMatrix ? "text-mint-700 font-bold" : "text-blue-500"}`}>
                                        {showMatrix ? (language === "es" ? "Ocultar matriz" : "Hide matrix") : (language === "es" ? "Matriz de habilidades" : "Skills matrix")}
                                    </button>
                                    <button onClick={clearBreakPlan} className="text-xs text-red-500 underline">
                                        {language === "es" ? "Borrar todo" : "Clear all"}
                                    </button>
                                </div>
                            </div>
                            {breakPlanSaved && (
                                <div className="bg-green-100 border border-green-300 text-green-700 text-sm rounded-lg px-3 py-2 text-center font-bold">
                                    {language === "es" ? "â Guardado" : "â Saved"}
                                </div>
                            )}

                            {/* Copy from another day */}
                            {breakDate !== getTodayKey() && Object.keys(breakPlan.stations || {}).length === 0 && (
                                <button onClick={async () => {
                                    const todayDocSnap = await getDoc(doc(db, "ops", "breakPlan_" + storeLocation + "_" + getTodayKey()));
                                    if (todayDocSnap.exists() && todayDocSnap.data().plan) {
                                        const plan = todayDocSnap.data().plan;
                                        const times = todayDocSnap.data().waveTimes || DEFAULT_BREAK_WAVES.map(w => w.time);
                                        setBreakPlan(plan);
                                        setBreakWaveTimes(times);
                                        saveBreakPlan(plan, times);
                                    } else {
                                        alert(language === "es" ? "No hay plan para hoy" : "No plan for today to copy");
                                    }
                                }}
                                    className="w-full py-2.5 rounded-xl font-bold text-sm bg-blue-50 text-blue-600 border-2 border-blue-200 hover:bg-blue-100 transition">
                                    ð {language === "es" ? "Copiar plan de hoy" : "Copy today's plan"}
                                </button>
                            )}

                            {/* ââ SKILLS MATRIX ââ */}
                            {showMatrix && (
                                <div className="bg-white border-2 border-purple-200 rounded-xl overflow-hidden">
                                    <div className="bg-purple-600 text-white px-4 py-2.5">
                                        <h3 className="font-bold text-sm">{language === "es" ? "ð§  Matriz de Habilidades" : "ð§  Skills Matrix"}</h3>
                                        <p className="text-xs text-purple-200">{language === "es" ? "Marca quÃ© estaciones puede trabajar cada persona" : "Check which stations each person can work"}</p>
                                    </div>
                                    <div className="overflow-x-auto">
                                        <table className="w-full text-xs">
                                            <thead>
                                                <tr className="bg-purple-50">
                                                    <th className="text-left px-3 py-2 font-bold text-gray-700 sticky left-0 bg-purple-50 z-10 min-w-[100px]">
                                                        {language === "es" ? "Nombre" : "Name"}
                                                    </th>
                                                    {SKILL_STATIONS.map(s => (
                                                        <th key={s.id} className="px-1 py-2 text-center font-bold text-gray-600 min-w-[40px]">
                                                            <div className="text-base">{s.emoji}</div>
                                                            <div className="text-[9px] leading-tight">{s.nameEn}</div>
                                                        </th>
                                                    ))}
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {bohStaff.map((staff, idx) => (
                                                    <tr key={staff.id} className={idx % 2 === 0 ? "bg-white" : "bg-gray-50"}>
                                                        <td className={`px-3 py-1.5 font-bold text-gray-800 sticky left-0 z-10 ${idx % 2 === 0 ? "bg-white" : "bg-gray-50"}`}>
                                                            {staff.name.split(" ")[0]}
                                                        </td>
                                                        {SKILL_STATIONS.map(s => {
                                                            const checked = !!skillsMatrix[staff.name + "_" + s.id];
                                                            return (
                                                                <td key={s.id} className="px-1 py-1.5 text-center">
                                                                    <button
                                                                        onClick={() => toggleSkill(staff.name, s.id)}
                                                                        className={`w-7 h-7 rounded-md text-sm font-bold transition ${
                                                                            checked
                                                                                ? "bg-mint-600 text-white"
                                                                                : "bg-gray-100 text-gray-300 hover:bg-gray-200"
                                                                        }`}
                                                                    >
                                                                        {checked ? "â" : ""}
                                                                    </button>
                                                                </td>
                                                            );
                                                        })}
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                    {/* Quick stats */}
                                    <div className="px-4 py-2 bg-purple-50 border-t border-purple-200 flex flex-wrap gap-3">
                                        {SKILL_STATIONS.map(s => {
                                            const count = bohStaff.filter(st => skillsMatrix[st.name + "_" + s.id]).length;
                                            return (
                                                <span key={s.id} className={`text-xs font-bold ${count === 0 ? "text-red-500" : count <= 2 ? "text-orange-500" : "text-gray-500"}`}>
                                                    {s.emoji} {count}
                                                </span>
                                            );
                                        })}
                                    </div>
                                </div>
                            )}

                            {/* ââ STATION BOARD ââ */}
                            <div className="bg-charcoal rounded-xl p-4">
                                <div className="flex items-center justify-between mb-3">
                                    <h3 className="text-white font-bold text-sm uppercase tracking-wider">
                                        {language === "es" ? "ð Estaciones de Hoy" : "ð Today's Stations"}
                                    </h3>
                                    {currentIsAdmin && (
                                        <button onClick={() => setEditingStations(!editingStations)}
                                            className={`text-xs px-2.5 py-1 rounded-full font-bold ${editingStations ? "bg-red-500 text-white" : "bg-white bg-opacity-20 text-white"}`}>
                                            {editingStations ? (language === "es" ? "â Cerrar" : "â Done") : (language === "es" ? "âï¸ Editar" : "âï¸ Edit")}
                                        </button>
                                    )}
                                </div>

                                {/* ââ EDIT MODE ââ */}
                                {editingStations && currentIsAdmin && (
                                    <div className="mb-3 space-y-2">
                                        {customStations.map((pos, idx) => (
                                            <div key={pos.id} className="bg-white bg-opacity-10 rounded-lg p-2 flex items-center gap-2">
                                                <div className="flex flex-col gap-0.5">
                                                    <button onClick={() => moveStation(pos.id, -1)} disabled={idx === 0}
                                                        className={`text-xs leading-none ${idx === 0 ? "text-gray-600" : "text-gray-300 hover:text-white"}`}>â²</button>
                                                    <button onClick={() => moveStation(pos.id, 1)} disabled={idx === customStations.length - 1}
                                                        className={`text-xs leading-none ${idx === customStations.length - 1 ? "text-gray-600" : "text-gray-300 hover:text-white"}`}>â¼</button>
                                                </div>
                                                <input type="text" value={pos.emoji} onChange={e => updateStationEmoji(pos.id, e.target.value)}
                                                    className="w-10 text-center text-lg bg-white bg-opacity-10 rounded border border-gray-600 text-white" style={{padding: "2px"}} />
                                                <input type="text" value={pos.nameEn} onChange={e => renameStation(pos.id, e.target.value)}
                                                    className="flex-1 bg-white bg-opacity-10 rounded border border-gray-600 text-white text-xs px-2 py-1.5 font-bold" />
                                                <button onClick={() => removeStation(pos.id)}
                                                    className="text-red-400 hover:text-red-300 text-sm font-bold px-1">â</button>
                                            </div>
                                        ))}
                                        {/* Add new station */}
                                        <div className="bg-white bg-opacity-5 rounded-lg p-2 flex items-center gap-2 border border-dashed border-gray-600">
                                            <input type="text" value={newStationEmoji} onChange={e => setNewStationEmoji(e.target.value)}
                                                className="w-10 text-center text-lg bg-white bg-opacity-10 rounded border border-gray-600 text-white" style={{padding: "2px"}}
                                                placeholder="ð" />
                                            <input type="text" value={newStationName} onChange={e => setNewStationName(e.target.value)}
                                                className="flex-1 bg-white bg-opacity-10 rounded border border-gray-600 text-white text-xs px-2 py-1.5"
                                                placeholder={language === "es" ? "Nueva estaciÃ³n..." : "New station name..."}
                                                onKeyDown={e => { if (e.key === "Enter") addStation(); }} />
                                            <button onClick={addStation}
                                                className="bg-mint text-white text-xs font-bold px-3 py-1.5 rounded hover:opacity-90">+</button>
                                        </div>
                                        {/* Reset to defaults */}
                                        <button onClick={resetStationsToDefault}
                                            className="text-xs text-gray-400 hover:text-gray-200 underline mt-1">
                                            {language === "es" ? "Restaurar predeterminados" : "Reset to defaults"}
                                        </button>
                                    </div>
                                )}

                                {/* ââ ASSIGNMENT GRID ââ */}
                                <div className="grid grid-cols-2 gap-2">
                                    {ALL_POSITIONS.map(pos => {
                                        const person = breakPlan.stations?.[pos.id] || "";
                                        return (
                                            <div key={pos.id} className="bg-white rounded-lg p-2.5">
                                                <div className="flex items-center gap-1.5 mb-1.5">
                                                    <span className="text-lg">{pos.emoji}</span>
                                                    <span className="font-bold text-xs text-charcoal">{language === "es" ? pos.nameEs : pos.nameEn}</span>
                                                </div>
                                                <select
                                                    className="w-full border border-gray-200 rounded px-2 py-1.5 text-xs bg-gray-50"
                                                    value={person}
                                                    onChange={e => updateStationAssignment(pos.id, e.target.value)}
                                                >
                                                    <option value="">â</option>
                                                    {(pos.id === "manager" ? (staffList || []).filter(s => ["Kitchen Manager", "Asst Kitchen Manager", "Manager", "Shift Lead"].includes(s.role) && (s.location === storeLocation || s.location === "both")) : bohStaff).map(s => (
                                                        <option key={s.id} value={s.name}>{s.name}</option>
                                                    ))}
                                                </select>
                                            </div>
                                        );
                                    })}
                                </div>

                                {/* Who's working today summary */}
                                {(() => {
                                    const assigned = getAssignedStaff();
                                    if (assigned.length === 0) return null;
                                    return (
                                        <div className="mt-3 pt-3 border-t border-gray-600">
                                            <p className="text-xs text-gray-400 mb-1">{language === "es" ? "Trabajando hoy" : "Working today"}: <span className="text-white font-bold">{assigned.length}</span></p>
                                            <p className="text-xs text-gray-300">{assigned.map(n => n.split(" ")[0]).join(", ")}</p>
                                        </div>
                                    );
                                })()}
                            </div>

                            {/* ââ BREAK WAVES ââ */}
                            {BREAK_WAVES.map((wave, waveIdx) => {
                                const assignedStaff = getAssignedStaff();
                                const breakers = getWaveBreakers(wave.id);
                                const available = getAvailableCovers(wave.id);
                                const needCover = getPositionsNeedingCover(wave.id);
                                const staffMap = getStaffPositionMap();

                                // People who already went on break in earlier waves
                                const alreadyBroke = new Set();
                                BREAK_WAVES.slice(0, waveIdx).forEach(prev => {
                                    getWaveBreakers(prev.id).forEach(n => alreadyBroke.add(n));
                                });

                                // Build cover assignment counts for warnings
                                const coverCounts = {};
                                needCover.forEach(nc => {
                                    const c = nc.cover;
                                    if (c) {
                                        if (!coverCounts[c]) coverCounts[c] = [];
                                        coverCounts[c].push(language === "es" ? nc.pos.nameEs : nc.pos.nameEn);
                                    }
                                });
                                const doubles = Object.entries(coverCounts).filter(([_, s]) => s.length > 1);
                                const uncovered = needCover.filter(nc => !nc.cover);

                                return (
                                    <div key={wave.id} className="bg-white border-2 border-blue-200 rounded-xl overflow-hidden">
                                        <div className="bg-blue-600 text-white px-4 py-2.5 flex items-center justify-between">
                                            <div className="flex items-center gap-2">
                                                <h3 className="font-bold text-sm">{language === "es" ? `Grupo ${waveIdx+1}` : `Wave ${waveIdx+1}`} â</h3>
                                                <input type="time" value={breakWaveTimes[waveIdx] || wave.time}
                                                    onChange={e => updateWaveTime(waveIdx, e.target.value)}
                                                    className="bg-blue-500 text-white border border-blue-400 rounded px-1.5 py-0.5 text-sm font-bold" style={{colorScheme:"dark"}} />
                                            </div>
                                            <span className="text-xs bg-blue-500 px-2 py-0.5 rounded-full">
                                                {breakers.length} {language === "es" ? "en break" : "on break"}
                                            </span>
                                        </div>

                                        <div className="p-3">
                                            {assignedStaff.length === 0 ? (
                                                <p className="text-center text-gray-400 text-sm py-4">
                                                    {language === "es" ? "Asigna estaciones primero" : "Assign stations first"}
                                                </p>
                                            ) : (
                                                <div>
                                                    {/* â Who's going on break? â */}
                                                    <p className="text-xs font-bold text-gray-500 uppercase tracking-wide mb-2">
                                                        {language === "es" ? "Â¿QuiÃ©n sale a break?" : "Who's going on break?"}
                                                    </p>
                                                    <div className="flex flex-wrap gap-1.5 mb-3">
                                                        {assignedStaff.map(name => {
                                                            const onBreak = breakers.includes(name);
                                                            const alreadyWent = alreadyBroke.has(name);
                                                            const positions = (staffMap[name] || []).map(p => p.emoji).join("");
                                                            if (alreadyWent && !onBreak) {
                                                                // Already took break in earlier wave â show grayed out
                                                                return (
                                                                    <span key={name}
                                                                        className="px-2.5 py-1.5 rounded-full text-xs font-bold border-2 bg-gray-100 text-gray-300 border-gray-100 line-through"
                                                                        title={language === "es" ? "Ya tomÃ³ break" : "Already took break"}
                                                                    >
                                                                        {positions} {name.split(" ")[0]}
                                                                    </span>
                                                                );
                                                            }
                                                            return (
                                                                <button key={name}
                                                                    onClick={() => toggleBreaker(wave.id, name)}
                                                                    className={`px-2.5 py-1.5 rounded-full text-xs font-bold transition border-2 ${
                                                                        onBreak
                                                                            ? "bg-orange-500 text-white border-orange-500"
                                                                            : "bg-white text-gray-700 border-gray-200 hover:border-orange-300"
                                                                    }`}
                                                                >
                                                                    {positions} {name.split(" ")[0]}
                                                                </button>
                                                            );
                                                        })}
                                                    </div>

                                                    {/* â Coverage map â */}
                                                    {needCover.length > 0 && (
                                                        <div>
                                                            <p className="text-xs font-bold text-mint-700 uppercase tracking-wide mb-2">
                                                                {language === "es" ? "Cobertura necesaria" : "Coverage needed"}
                                                            </p>
                                                            <div className="space-y-2">
                                                                {needCover.map(nc => (
                                                                    <div key={nc.pos.id} className="flex items-center gap-2 bg-orange-50 border border-orange-200 rounded-lg p-2">
                                                                        <span className="text-lg">{nc.pos.emoji}</span>
                                                                        <div className="flex-1 min-w-0">
                                                                            <div className="text-xs">
                                                                                <span className="font-bold text-gray-500">{language === "es" ? nc.pos.nameEs : nc.pos.nameEn}</span>
                                                                                <span className="text-orange-500 ml-1">({nc.person.split(" ")[0]} {language === "es" ? "en break" : "on break"})</span>
                                                                            </div>
                                                                            <select
                                                                                className={`w-full mt-1 border rounded px-2 py-1.5 text-xs font-bold ${nc.cover ? "border-mint-400 bg-mint-50 text-mint-800" : "border-red-300 bg-red-50 text-red-700"}`}
                                                                                value={nc.cover}
                                                                                onChange={e => setWaveCover(wave.id, nc.pos.id, e.target.value)}
                                                                            >
                                                                                <option value="">{language === "es" ? "â ï¸ Seleccionar cobertura..." : "â ï¸ Select cover..."}</option>
                                                                                {(() => {
                                                                                    const qualified = getQualifiedCovers(nc.pos.id, available, wave.id);
                                                                                    const unqualified = available.filter(n => !qualified.includes(n));
                                                                                    return [
                                                                                        ...qualified.map(n => (
                                                                                            <option key={n} value={n}>â {n} {(staffMap[n] || []).map(p => p.emoji).join("")}</option>
                                                                                        )),
                                                                                        unqualified.length > 0 && qualified.length > 0 ? <option key="_sep" disabled>âââââââ</option> : null,
                                                                                        ...unqualified.map(n => (
                                                                                            <option key={n} value={n} style={{color:"#999"}}>{n}</option>
                                                                                        ))
                                                                                    ];
                                                                                })()}
                                                                            </select>
                                                                        </div>
                                                                    </div>
                                                                ))}
                                                            </div>
                                                        </div>
                                                    )}

                                                    {/* â Still working (not on break) â */}
                                                    {breakers.length > 0 && available.length > 0 && (
                                                        <div className="mt-3 pt-2 border-t border-gray-200">
                                                            <p className="text-xs font-bold text-gray-400 mb-1">
                                                                {language === "es" ? "Trabajando" : "Still working"}: {available.map(n => {
                                                                    const positions = (staffMap[n] || []).map(p => p.emoji).join("");
                                                                    return positions + " " + n.split(" ")[0];
                                                                }).join(", ")}
                                                            </p>
                                                        </div>
                                                    )}

                                                    {/* â Warnings â */}
                                                    {(uncovered.length > 0 || doubles.length > 0) && (
                                                        <div className="mt-2 space-y-1">
                                                            {uncovered.length > 0 && (
                                                                <div className="text-xs text-red-600 font-bold bg-red-50 rounded px-2 py-1">
                                                                    â ï¸ {language === "es" ? "Sin cubrir" : "Uncovered"}: {uncovered.map(nc => (language === "es" ? nc.pos.nameEs : nc.pos.nameEn)).join(", ")}
                                                                </div>
                                                            )}
                                                            {doubles.map(([name, stations]) => (
                                                                <div key={name} className="text-xs text-orange-700 bg-orange-50 rounded px-2 py-1">
                                                                    â ï¸ <span className="font-bold">{name.split(" ")[0]}</span> {language === "es" ? "cubre" : "covers"} {stations.join(" + ")}
                                                                </div>
                                                            ))}
                                                        </div>
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                );
                            })}
                            {/* ââ PRINT BUTTON ââ */}
                            {(() => {
                                const assigned = getAssignedStaff();
                                if (assigned.length === 0) return null;
                                return (
                                    <button onClick={() => {
                                        const today = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
                                        const staffMap = getStaffPositionMap();
                                        let html = `<html><head><title>Break Plan - ${today}</title><style>
                                            * { margin: 0; padding: 0; box-sizing: border-box; }
                                            body { font-family: Arial, sans-serif; padding: 20px; max-width: 700px; margin: 0 auto; }
                                            h1 { font-size: 22px; text-align: center; margin-bottom: 2px; }
                                            .date { text-align: center; color: #666; font-size: 13px; margin-bottom: 16px; }
                                            .section { border: 2px solid #333; border-radius: 8px; margin-bottom: 14px; overflow: hidden; }
                                            .section-header { background: #333; color: white; padding: 6px 12px; font-weight: bold; font-size: 14px; }
                                            .station-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0; }
                                            .station { padding: 6px 12px; border-bottom: 1px solid #ddd; border-right: 1px solid #ddd; font-size: 13px; }
                                            .station:nth-child(even) { border-right: none; }
                                            .station-name { font-weight: bold; color: #333; font-size: 11px; text-transform: uppercase; }
                                            .station-person { color: #000; font-size: 14px; margin-top: 1px; }
                                            .wave { margin-bottom: 12px; }
                                            .wave-header { background: #2563eb; color: white; padding: 6px 12px; font-weight: bold; font-size: 14px; }
                                            .wave-body { padding: 8px 12px; }
                                            .wave-row { display: flex; justify-content: space-between; align-items: center; padding: 4px 0; border-bottom: 1px solid #eee; font-size: 13px; }
                                            .wave-row:last-child { border-bottom: none; }
                                            .breakers { font-weight: bold; color: #ea580c; }
                                            .cover-label { color: #666; font-size: 11px; }
                                            .cover-name { font-weight: bold; color: #15803d; }
                                            .working { color: #666; font-size: 12px; margin-top: 6px; }
                                            @media print { body { padding: 10px; } }
                                        </style></head><body>`;
                                        html += `<h1>ð DD Mau Break Plan</h1><div class="date">${today}</div>`;

                                        // Stations
                                        html += `<div class="section"><div class="section-header">ð Today's Stations</div><div class="station-grid">`;
                                        ALL_POSITIONS.forEach(pos => {
                                            const person = breakPlan.stations?.[pos.id] || "â";
                                            html += `<div class="station"><div class="station-name">${pos.emoji} ${pos.nameEn}</div><div class="station-person">${person}</div></div>`;
                                        });
                                        html += `</div></div>`;

                                        // Break waves
                                        BREAK_WAVES.forEach((wave, waveIdx) => {
                                            const breakers = getWaveBreakers(wave.id);
                                            const available = getAvailableCovers(wave.id);
                                            const needCover = getPositionsNeedingCover(wave.id);
                                            html += `<div class="section"><div class="wave-header">${wave.nameEn}</div><div class="wave-body">`;
                                            if (breakers.length > 0) {
                                                html += `<div style="margin-bottom:6px"><span class="breakers">On break: ${breakers.map(n => n.split(" ")[0]).join(", ")}</span></div>`;
                                                needCover.forEach(nc => {
                                                    const coverName = nc.cover ? nc.cover.split(" ")[0] : "â ï¸ UNCOVERED";
                                                    html += `<div class="wave-row"><span>${nc.pos.emoji} ${nc.pos.nameEn} <span class="cover-label">(${nc.person.split(" ")[0]} on break)</span></span><span class="cover-name">â ${coverName}</span></div>`;
                                                });
                                                if (available.length > 0) {
                                                    html += `<div class="working">Still working: ${available.map(n => { const positions = (staffMap[n] || []).map(p => p.emoji).join(""); return positions + " " + n.split(" ")[0]; }).join(", ")}</div>`;
                                                }
                                            } else {
                                                html += `<div style="color:#999;font-size:13px">No breaks assigned</div>`;
                                            }
                                            html += `</div></div>`;
                                        });

                                        html += `</body></html>`;
                                        const printWindow = window.open("", "_blank");
                                        printWindow.document.write(html);
                                        printWindow.document.close();
                                        printWindow.focus();
                                        setTimeout(() => printWindow.print(), 300);
                                    }}
                                        className="w-full mt-4 py-3 rounded-xl font-bold text-sm bg-blue-600 text-white hover:bg-blue-700 active:scale-95 transition flex items-center justify-center gap-2">
                                        ð¨ï¸ {language === "es" ? "Imprimir Plan de Breaks" : "Print Break Plan"}
                                    </button>
                                );
                            })()}
                        </div>
                    )}
                </div>
            );
        }

        // Menu Reference Component
        function MenuReference({ language }) {
            const [expandedCategory, setExpandedCategory] = useState(null);

            return (
                <div className="p-4 pb-24">
                    <h2 className="text-2xl font-bold text-mint-700 mb-4">ð {t("menuReference", language)}</h2>

                    <div className="space-y-3">
                        {MENU_DATA.map((category, idx) => (
                            <div key={idx} className="bg-white rounded-lg border-2 border-gray-200 overflow-hidden">
                                <button
                                    onClick={() => setExpandedCategory(expandedCategory === idx ? null : idx)}
                                    className="w-full p-4 text-left bg-gradient-to-r from-mint-50 to-white hover:bg-mint-50 border-b flex justify-between items-center"
                                >
                                    <h3 className="font-bold text-lg text-mint-700">{language === "es" ? category.categoryEs : category.category}</h3>
                                    <span className="text-xl">{expandedCategory === idx ? "â¼" : "â¶"}</span>
                                </button>

                                {expandedCategory === idx && (
                                    <div className="p-4 space-y-4">
                                        {category.items.map((item, itemIdx) => (
                                            <div key={itemIdx} className="pb-4 border-b last:border-b-0">
                                                <div className="flex justify-between items-start mb-2">
                                                    <div>
                                                        <h4 className="font-bold text-gray-800">{language === "es" ? item.nameEn : item.nameEn}</h4>
                                                        {item.nameVi && <p className="text-sm text-gray-600">{item.nameVi}</p>}
                                                    </div>
                                                    <p className="font-bold text-mint-700">{item.price}</p>
                                                </div>
                                                <p className="text-sm text-gray-700 mb-2">{language === "es" ? item.descEs : item.descEn}</p>
                                                <div className="flex gap-2 flex-wrap text-xs">
                                                    {item.popular && <span className="bg-mint-100 text-mint-700 px-2 py-1 rounded">â­ {t("popular", language)}</span>}
                                                    {item.spicy && <span className="bg-orange-100 text-orange-700 px-2 py-1 rounded">ð¶ {t("spicy", language)}</span>}
                                                    {item.allergens && <span className="bg-yellow-100 text-yellow-700 px-2 py-1 rounded">â  {item.allergens}</span>}
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                </div>
            );
        }

        // Schedule Component
        function Schedule({ staffName, language, storeLocation, staffList }) {
            const getStaffLocation = (name) => {
                const s = (staffList || []).find(st => st.name === name);
                return s?.location || "webster";
            };
            const filterByLocation = (entries) => entries.filter(e => {
                const loc = getStaffLocation(e.name);
                return loc === storeLocation || loc === "both";
            });

            return (
                <div className="p-4 pb-24">
                    <h2 className="text-2xl font-bold text-mint-700 mb-2">ð {t("weeklySchedule", language)}</h2>
                    <p className="text-gray-600 mb-4">{SCHEDULE_DATA.week} â <span className="font-bold text-mint-700">{LOCATION_LABELS[storeLocation]}</span></p>

                    <div className="space-y-4">
                        {SCHEDULE_DATA.shifts.map((day, idx) => {
                            const filteredSchedule = filterByLocation(day.schedule);
                            return (
                            <div key={idx} className="bg-white rounded-lg border-2 border-gray-200 overflow-hidden">
                                <div className="p-4 bg-gradient-to-r from-mint-50 to-white border-b">
                                    <h3 className="font-bold text-lg text-mint-700">{day.day}</h3>
                                    {day.note && <p className="text-xs text-orange-600 mt-1">ð {day.note}</p>}
                                </div>

                                <div className="p-4 space-y-2">
                                    {filteredSchedule.length === 0 && <p className="text-gray-400 text-sm text-center py-2">{language === "es" ? "Sin turnos programados" : "No shifts scheduled"}</p>}
                                    {filteredSchedule.map((entry, entryIdx) => {
                                        const isCurrentStaff = entry.name === staffName;
                                        return (
                                            <div
                                                key={entryIdx}
                                                className={`p-3 rounded-lg ${isCurrentStaff ? "bg-green-50 border-2 border-green-700" : "bg-gray-50 border-2 border-gray-200"}`}
                                            >
                                                <p className={`font-bold ${isCurrentStaff ? "text-green-700" : "text-gray-800"}`}>
                                                    {isCurrentStaff ? "â " : ""}{entry.name}
                                                </p>
                                                <p className="text-sm text-gray-600">{entry.shift}</p>
                                                <p className="text-xs text-gray-500">{entry.role}</p>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        );
                        })}
                    </div>
                </div>
            );
        }

        // DD Mau Location Coordinates
        const DD_MAU_LOCATIONS = [
            { name: "Maryland Heights", lat: 38.7138, lng: -90.4391 },
            { name: "Webster Groves", lat: 38.5917, lng: -90.3389 }
        ];
        const GEOFENCE_RADIUS_FEET = 500;

        // Haversine distance in feet
        function getDistanceFeet(lat1, lng1, lat2, lng2) {
            const R = 20902231; // Earth radius in feet
            const dLat = (lat2 - lat1) * Math.PI / 180;
            const dLng = (lng2 - lng1) * Math.PI / 180;
            const a = Math.sin(dLat / 2) ** 2 +
                Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
                Math.sin(dLng / 2) ** 2;
            return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        }

        function isWithinGeofence(lat, lng) {
            return DD_MAU_LOCATIONS.some(loc =>
                getDistanceFeet(lat, lng, loc.lat, loc.lng) <= GEOFENCE_RADIUS_FEET
            );
        }

        // Geofence hook
        function useGeofence() {
            const [isAtDDMau, setIsAtDDMau] = useState(false);
            const [checking, setChecking] = useState(true);
            const [error, setError] = useState(null);

            useEffect(() => {
                if (!navigator.geolocation) {
                    setError("noGeo");
                    setChecking(false);
                    return;
                }

                const watchId = navigator.geolocation.watchPosition(
                    (pos) => {
                        const inside = isWithinGeofence(pos.coords.latitude, pos.coords.longitude);
                        setIsAtDDMau(inside);
                        setChecking(false);
                        setError(null);
                    },
                    (err) => {
                        setError(err.code === 1 ? "denied" : "unavailable");
                        setChecking(false);
                    },
                    { enableHighAccuracy: true, maximumAge: 30000, timeout: 10000 }
                );

                return () => navigator.geolocation.clearWatch(watchId);
            }, []);

            return { isAtDDMau, checking, error };
        }

        // Placeholder Recipe Data
        const RECIPES = [
            {
                id: 1,
                titleEn: "Pho Broth (Beef)",
                titleEs: "Caldo de Pho (Res)",
                emoji: "ð²",
                category: "Soups",
                prepTimeEn: "30 min", cookTimeEn: "12 hours",
                yieldsEn: "5 gallons", yieldsEs: "19 litros",
                ingredientsEn: [
                    "10 lbs beef bones (knuckle & marrow)",
                    "2 lbs beef chuck",
                    "3 large onions, halved & charred",
                    "6 inch ginger, halved & charred",
                    "5 star anise pods",
                    "6 whole cloves",
                    "2 cinnamon sticks",
                    "1 tbsp coriander seeds",
                    "1/4 cup fish sauce",
                    "2 tbsp sugar",
                    "Salt to taste"
                ],
                ingredientsEs: [
                    "10 lbs huesos de res (nudillo y tuÃ©tano)",
                    "2 lbs chuck de res",
                    "3 cebollas grandes, cortadas y asadas",
                    "6 pulgadas de jengibre, cortado y asado",
                    "5 vainas de anÃ­s estrella",
                    "6 clavos enteros",
                    "2 rajas de canela",
                    "1 cucharada de semillas de cilantro",
                    "1/4 taza de salsa de pescado",
                    "2 cucharadas de azÃºcar",
                    "Sal al gusto"
                ],
                instructionsEn: [
                    "Blanch bones in boiling water 10 min, drain and rinse.",
                    "Char onions and ginger under broiler until blackened.",
                    "Toast star anise, cloves, cinnamon, coriander in dry pan until fragrant.",
                    "Add bones and beef chuck to large stockpot, cover with 7 gallons cold water.",
                    "Bring to boil, then reduce to gentle simmer. Skim scum frequently for first hour.",
                    "Add charred onions, ginger, and toasted spices in cheesecloth bag.",
                    "Simmer 12 hours minimum, skimming occasionally.",
                    "Remove chuck after 1.5 hours (reserve for slicing).",
                    "Strain broth through fine mesh. Season with fish sauce, sugar, salt.",
                    "Cool properly: ice bath to 70Â°F within 2 hours, then refrigerate."
                ],
                instructionsEs: [
                    "Blanquea los huesos en agua hirviendo 10 min, escurre y enjuaga.",
                    "Asa las cebollas y el jengibre bajo el asador hasta que estÃ©n ennegrecidos.",
                    "Tuesta anÃ­s estrella, clavos, canela, cilantro en sartÃ©n seco hasta que estÃ©n fragantes.",
                    "Agrega huesos y chuck a una olla grande, cubre con 7 galones de agua frÃ­a.",
                    "Lleva a hervor, luego reduce a fuego lento. Retira la espuma frecuentemente la primera hora.",
                    "Agrega cebollas asadas, jengibre y especias tostadas en bolsa de manta.",
                    "Cocina a fuego lento 12 horas mÃ­nimo, retirando espuma ocasionalmente.",
                    "Retira el chuck despuÃ©s de 1.5 horas (reserva para rebanar).",
                    "Cuela el caldo por malla fina. Sazona con salsa de pescado, azÃºcar, sal.",
                    "EnfrÃ­a correctamente: baÃ±o de hielo a 21Â°C en 2 horas, luego refrigera."
                ]
            },
            {
                id: 2,
                titleEn: "Egg Rolls (Cháº£ GiÃ²)",
                titleEs: "Rollitos Fritos (Cháº£ GiÃ²)",
                emoji: "ð¥",
                category: "Appetizers",
                prepTimeEn: "45 min", cookTimeEn: "8 min per batch",
                yieldsEn: "50 rolls", yieldsEs: "50 rollitos",
                ingredientsEn: [
                    "2 lbs ground pork",
                    "1 lb shrimp, minced",
                    "1 pack bean thread noodles, soaked & chopped",
                    "1 cup wood ear mushrooms, soaked & minced",
                    "2 cups shredded carrots",
                    "1 cup shredded taro",
                    "1 medium onion, finely diced",
                    "4 eggs",
                    "2 tbsp fish sauce",
                    "1 tsp black pepper",
                    "1 pack egg roll wrappers (wheat-based)"
                ],
                ingredientsEs: [
                    "2 lbs carne molida de cerdo",
                    "1 lb camarÃ³n, picado",
                    "1 paquete de fideos de frijol, remojados y picados",
                    "1 taza de hongos oreja de madera, remojados y picados",
                    "2 tazas de zanahoria rallada",
                    "1 taza de taro rallado",
                    "1 cebolla mediana, finamente picada",
                    "4 huevos",
                    "2 cucharadas de salsa de pescado",
                    "1 cucharadita de pimienta negra",
                    "1 paquete de masa para rollitos (a base de trigo)"
                ],
                instructionsEn: [
                    "Mix pork, shrimp, noodles, mushrooms, carrots, taro, onion in large bowl.",
                    "Add eggs, fish sauce, and pepper. Mix thoroughly by hand.",
                    "Place 2 tbsp filling on each wrapper. Roll tightly, sealing edge with egg wash.",
                    "Heat oil to 325Â°F for first fry (5 min until light golden). Drain on rack.",
                    "Increase oil to 350Â°F. Second fry 2-3 min until deep golden and crispy.",
                    "Internal temp must reach 165Â°F. Check 3 rolls per batch.",
                    "Serve with nÆ°á»c cháº¥m dipping sauce and lettuce wraps."
                ],
                instructionsEs: [
                    "Mezcla cerdo, camarÃ³n, fideos, hongos, zanahoria, taro, cebolla en un tazÃ³n grande.",
                    "Agrega huevos, salsa de pescado y pimienta. Mezcla bien a mano.",
                    "Coloca 2 cucharadas de relleno en cada masa. Enrolla firmemente, sella con huevo batido.",
                    "Calienta aceite a 163Â°C para primera fritura (5 min hasta dorado claro). Escurre en rejilla.",
                    "Sube aceite a 177Â°C. Segunda fritura 2-3 min hasta dorado profundo y crujiente.",
                    "La temperatura interna debe alcanzar 74Â°C. Revisa 3 rollitos por lote.",
                    "Sirve con salsa nÆ°á»c cháº¥m y hojas de lechuga."
                ]
            },
            {
                id: 3,
                titleEn: "NÆ°á»c Cháº¥m (Dipping Sauce)",
                titleEs: "NÆ°á»c Cháº¥m (Salsa para Mojar)",
                emoji: "ð«",
                category: "Sauces",
                prepTimeEn: "10 min", cookTimeEn: "None",
                yieldsEn: "1 quart", yieldsEs: "1 litro",
                ingredientsEn: [
                    "1 cup fish sauce",
                    "1 cup sugar",
                    "2 cups warm water",
                    "1/2 cup lime juice (fresh)",
                    "4 cloves garlic, minced",
                    "2 Thai chilies, minced",
                    "2 tbsp shredded carrot (garnish)"
                ],
                ingredientsEs: [
                    "1 taza de salsa de pescado",
                    "1 taza de azÃºcar",
                    "2 tazas de agua tibia",
                    "1/2 taza de jugo de limÃ³n (fresco)",
                    "4 dientes de ajo, picados",
                    "2 chiles Thai, picados",
                    "2 cucharadas de zanahoria rallada (guarniciÃ³n)"
                ],
                instructionsEn: [
                    "Dissolve sugar in warm water completely.",
                    "Add fish sauce and lime juice. Stir to combine.",
                    "Add minced garlic and Thai chilies.",
                    "Taste and adjust: more sugar if too salty, more lime if too sweet.",
                    "Garnish with shredded carrot. Refrigerate.",
                    "Keeps 5 days refrigerated. Label with prep date."
                ],
                instructionsEs: [
                    "Disuelve el azÃºcar en agua tibia completamente.",
                    "Agrega salsa de pescado y jugo de limÃ³n. Mezcla para combinar.",
                    "Agrega ajo picado y chiles Thai.",
                    "Prueba y ajusta: mÃ¡s azÃºcar si estÃ¡ muy salado, mÃ¡s limÃ³n si estÃ¡ muy dulce.",
                    "Decora con zanahoria rallada. Refrigera.",
                    "Se conserva 5 dÃ­as refrigerado. Etiqueta con fecha de preparaciÃ³n."
                ]
            },
            {
                id: 4,
                titleEn: "Vietnamese Iced Coffee (CÃ  PhÃª Sá»¯a ÄÃ¡)",
                titleEs: "CafÃ© Vietnamita Helado (CÃ  PhÃª Sá»¯a ÄÃ¡)",
                emoji: "â",
                category: "Drinks",
                prepTimeEn: "5 min", cookTimeEn: "4 min drip",
                yieldsEn: "1 serving", yieldsEs: "1 porciÃ³n",
                ingredientsEn: [
                    "2 tbsp Vietnamese ground coffee (Trung Nguyen or CafÃ© Du Monde)",
                    "2-3 tbsp sweetened condensed milk",
                    "6 oz boiling water",
                    "Ice to fill glass",
                    "Phin filter (Vietnamese drip filter)"
                ],
                ingredientsEs: [
                    "2 cucharadas de cafÃ© molido vietnamita (Trung Nguyen o CafÃ© Du Monde)",
                    "2-3 cucharadas de leche condensada azucarada",
                    "6 oz de agua hirviendo",
                    "Hielo para llenar el vaso",
                    "Filtro Phin (filtro de goteo vietnamita)"
                ],
                instructionsEn: [
                    "Add condensed milk to the bottom of a glass.",
                    "Place phin filter on top of glass. Add coffee grounds, press lightly with filter press.",
                    "Pour a small amount of hot water to bloom (30 seconds).",
                    "Fill phin with remaining hot water. Cover and let drip (4-5 min).",
                    "Once dripped, stir coffee and condensed milk together.",
                    "Pour over a full glass of ice. Serve immediately."
                ],
                instructionsEs: [
                    "Agrega leche condensada al fondo de un vaso.",
                    "Coloca el filtro phin encima del vaso. Agrega cafÃ© molido, presiona ligeramente.",
                    "Vierte una pequeÃ±a cantidad de agua caliente para florecer (30 segundos).",
                    "Llena el phin con el agua caliente restante. Tapa y deja gotear (4-5 min).",
                    "Una vez goteado, mezcla el cafÃ© y la leche condensada.",
                    "Vierte sobre un vaso lleno de hielo. Sirve inmediatamente."
                ]
            }
        ];

        // Recipe password for edit access (admin only)
        const RECIPE_PASSWORD = "ZhongGuo87";

        // Recipe Form Component
        function RecipeForm({ language, recipe, onSave, onCancel }) {
            const isEdit = !!recipe;
            const [form, setForm] = useState(recipe || {
                titleEn: "", titleEs: "", emoji: "ð½ï¸", category: "",
                prepTimeEn: "", cookTimeEn: "",
                yieldsEn: "", yieldsEs: "",
                ingredientsEn: [""], ingredientsEs: [""],
                instructionsEn: [""], instructionsEs: [""]
            });

            const updateField = (field, val) => setForm(prev => ({ ...prev, [field]: val }));
            const updateListItem = (field, idx, val) => {
                const arr = [...form[field]];
                arr[idx] = val;
                setForm(prev => ({ ...prev, [field]: arr }));
            };
            const addListItem = (field) => setForm(prev => ({ ...prev, [field]: [...prev[field], ""] }));
            const removeListItem = (field, idx) => {
                if (form[field].length <= 1) return;
                setForm(prev => ({ ...prev, [field]: prev[field].filter((_, i) => i !== idx) }));
            };

            const handleSave = () => {
                if (!form.titleEn.trim()) { alert(language === "es" ? "Se requiere tÃ­tulo en inglÃ©s" : "English title is required"); return; }
                const cleaned = {
                    ...form,
                    ingredientsEn: form.ingredientsEn.filter(s => s.trim()),
                    ingredientsEs: form.ingredientsEs.filter(s => s.trim()),
                    instructionsEn: form.instructionsEn.filter(s => s.trim()),
                    instructionsEs: form.instructionsEs.filter(s => s.trim()),
                };
                if (cleaned.ingredientsEn.length === 0) cleaned.ingredientsEn = [""];
                if (cleaned.instructionsEn.length === 0) cleaned.instructionsEn = [""];
                if (cleaned.ingredientsEs.length === 0) cleaned.ingredientsEs = [""];
                if (cleaned.instructionsEs.length === 0) cleaned.instructionsEs = [""];
                onSave(cleaned);
            };

            const renderListEditor = (field, label) => (
                <div className="mb-4">
                    <label className="block text-xs font-bold text-gray-600 mb-1">{label}</label>
                    {form[field].map((item, i) => (
                        <div key={i} className="flex gap-1 mb-1">
                            <span className="text-xs text-gray-400 mt-2 w-5 text-right">{i + 1}.</span>
                            <input
                                className="flex-1 border border-gray-300 rounded px-2 py-1 text-sm"
                                value={item}
                                onChange={e => updateListItem(field, i, e.target.value)}
                                placeholder={`${label} ${i + 1}`}
                            />
                            <button onClick={() => removeListItem(field, i)} className="text-red-400 text-sm px-1">â</button>
                        </div>
                    ))}
                    <button onClick={() => addListItem(field)} className="text-xs text-mint-700 font-bold mt-1">{language === "es" ? "+ Agregar" : "+ Add"}</button>
                </div>
            );

            return (
                <div className="p-4 pb-24">
                    <div className="flex items-center justify-between mb-4">
                        <h2 className="text-xl font-bold text-mint-700">
                            {isEdit ? (language === "es" ? "Editar Receta" : "Edit Recipe") : (language === "es" ? "Nueva Receta" : "New Recipe")}
                        </h2>
                        <button onClick={onCancel} className="text-gray-500 text-sm underline">{language === "es" ? "Cancelar" : "Cancel"}</button>
                    </div>

                    <div className="space-y-3">
                        <div className="flex gap-2">
                            <div className="w-16">
                                <label className="block text-xs font-bold text-gray-600 mb-1">{language === "es" ? "Ãcono" : "Emoji"}</label>
                                <input className="w-full border border-gray-300 rounded px-2 py-1 text-center text-xl" value={form.emoji} onChange={e => updateField("emoji", e.target.value)} />
                            </div>
                            <div className="flex-1">
                                <label className="block text-xs font-bold text-gray-600 mb-1">{language === "es" ? "CategorÃ­a" : "Category"}</label>
                                <input className="w-full border border-gray-300 rounded px-2 py-1 text-sm" value={form.category} onChange={e => updateField("category", e.target.value)} placeholder={language === "es" ? "ej. Sopas, Aperitivos, Salsas" : "e.g. Soups, Appetizers, Sauces"} />
                            </div>
                        </div>

                        <div>
                            <label className="block text-xs font-bold text-gray-600 mb-1">{language === "es" ? "TÃ­tulo (InglÃ©s) *" : "Title (English) *"}</label>
                            <input className="w-full border border-gray-300 rounded px-2 py-1 text-sm" value={form.titleEn} onChange={e => updateField("titleEn", e.target.value)} placeholder={language === "es" ? "Nombre de la receta en inglÃ©s" : "Recipe name in English"} />
                        </div>
                        <div>
                            <label className="block text-xs font-bold text-gray-600 mb-1">{language === "es" ? "TÃ­tulo (EspaÃ±ol)" : "Title (Spanish)"}</label>
                            <input className="w-full border border-gray-300 rounded px-2 py-1 text-sm" value={form.titleEs} onChange={e => updateField("titleEs", e.target.value)} placeholder={language === "es" ? "Nombre en espaÃ±ol" : "Recipe name in Spanish"} />
                        </div>

                        <div className="flex gap-2">
                            <div className="flex-1">
                                <label className="block text-xs font-bold text-gray-600 mb-1">{t("prepTime", language)}</label>
                                <input className="w-full border border-gray-300 rounded px-2 py-1 text-sm" value={form.prepTimeEn} onChange={e => updateField("prepTimeEn", e.target.value)} placeholder={language === "es" ? "ej. 30 min" : "e.g. 30 min"} />
                            </div>
                            <div className="flex-1">
                                <label className="block text-xs font-bold text-gray-600 mb-1">{t("cookTime", language)}</label>
                                <input className="w-full border border-gray-300 rounded px-2 py-1 text-sm" value={form.cookTimeEn} onChange={e => updateField("cookTimeEn", e.target.value)} placeholder={language === "es" ? "ej. 2 horas" : "e.g. 2 hours"} />
                            </div>
                        </div>

                        <div className="flex gap-2">
                            <div className="flex-1">
                                <label className="block text-xs font-bold text-gray-600 mb-1">{t("yields", language)} (EN)</label>
                                <input className="w-full border border-gray-300 rounded px-2 py-1 text-sm" value={form.yieldsEn} onChange={e => updateField("yieldsEn", e.target.value)} placeholder={language === "es" ? "ej. 5 galones" : "e.g. 5 gallons"} />
                            </div>
                            <div className="flex-1">
                                <label className="block text-xs font-bold text-gray-600 mb-1">{t("yields", language)} (ES)</label>
                                <input className="w-full border border-gray-300 rounded px-2 py-1 text-sm" value={form.yieldsEs} onChange={e => updateField("yieldsEs", e.target.value)} placeholder="e.g. 19 litros" />
                            </div>
                        </div>

                        <div className="border-t pt-3 mt-3">
                            <h3 className="font-bold text-sm text-amber-800 mb-2">ð {t("ingredients", language)}</h3>
                            {renderListEditor("ingredientsEn", language === "es" ? "InglÃ©s" : "English")}
                            {renderListEditor("ingredientsEs", language === "es" ? "EspaÃ±ol" : "Spanish")}
                        </div>

                        <div className="border-t pt-3 mt-3">
                            <h3 className="font-bold text-sm text-amber-800 mb-2">ð¨âð³ {t("instructions", language)}</h3>
                            {renderListEditor("instructionsEn", language === "es" ? "InglÃ©s" : "English")}
                            {renderListEditor("instructionsEs", language === "es" ? "EspaÃ±ol" : "Spanish")}
                        </div>

                        <button
                            onClick={handleSave}
                            className="w-full bg-mint-700 text-white font-bold py-3 rounded-lg text-lg mt-4"
                        >
                            {isEdit ? (language === "es" ? "Guardar Cambios" : "Save Changes") : (language === "es" ? "Agregar Receta" : "Add Recipe")}
                        </button>
                    </div>
                </div>
            );
        }

