import { useState, useEffect, useRef } from 'react';
import { db, storage } from '../firebase';
import { doc, onSnapshot, setDoc, getDoc, getDocs, updateDoc, query, collection, orderBy, limit, where, writeBatch, serverTimestamp, deleteDoc, deleteField } from 'firebase/firestore';
import { ref, getDownloadURL, uploadBytes } from 'firebase/storage';
import { t, autoTranslateItem } from '../data/translations';
import { isAdmin, ADMIN_NAMES, DEFAULT_STAFF, LOCATION_LABELS } from '../data/staff';
import { INVENTORY_CATEGORIES } from '../data/inventory';
import InventoryHistory from './InventoryHistory';
import PrepList from './PrepList';

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
            const currentIsAdmin = isAdmin(staffName, staffList);

            // New checklist system {"\u{2014}"} FOH/BOH with multiple lists per side
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
            // Staff filter for master task list view (admin picks a name, or "" for all)
            const [taskFilter, setTaskFilter] = useState("");
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
            const [livePrices, setLivePrices] = useState({}); // { sysco: { prices: { itemId: { price, pack, ... } }, lastScraped } }
            const [syscoTriggerStatus, setSyscoTriggerStatus] = useState(null); // null | "requesting" | "running" | "done" | "error"
            const [showSaveConfirm, setShowSaveConfirm] = useState(false);
            const [inventorySaving, setInventorySaving] = useState(false);
            const [invSearch, setInvSearch] = useState("");
            const [writeInValues, setWriteInValues] = useState({});
            const [invViewMode, setInvViewMode] = useState("category"); // "category" or "vendor"
            const [collapsedCats, setCollapsedCats] = useState({});
            const [invShowOnlyCounted, setInvShowOnlyCounted] = useState(false);
            const [vendorChangeLog, setVendorChangeLog] = useState([]);
            const [showVendorLog, setShowVendorLog] = useState(false);
            const [showCart, setShowCart] = useState(false);
            // Split list state: overrides move items between people, writeIns are custom items per person
            const [splitOverrides, setSplitOverrides] = useState({}); // {itemId: personName}
            const [splitWriteIns, setSplitWriteIns] = useState({}); // {personName: [{id, name, count}]}
            const [splitWriteInValues, setSplitWriteInValues] = useState({}); // {personName: "text"}
            const [splitMovingItem, setSplitMovingItem] = useState(null); // {itemId, fromPerson}

            // Break Planner state
            const DEFAULT_STATIONS = [
                { id: "fry", nameEn: "Fry", nameEs: "Freidora", emoji: "\u{1F35F}" },
                { id: "pho", nameEn: "Pho", nameEs: "Pho", emoji: "\u{1F372}" },
                { id: "grill", nameEn: "Grill", nameEs: "Parrilla", emoji: "\u{1F525}" },
                { id: "bao", nameEn: "Bao", nameEs: "Bao", emoji: "\u{1F95F}" },
                { id: "springroll", nameEn: "Spring Roll", nameEs: "Rollito", emoji: "\u{1F32F}" },
                { id: "wok", nameEn: "Wok", nameEs: "Wok", emoji: "\u{1F958}" },
                { id: "bowls", nameEn: "Bowls", nameEs: "Bowls", emoji: "\u{1F957}" },
                { id: "friedrice1", nameEn: "Fried Rice 1", nameEs: "Arroz Frito 1", emoji: "\u{1F373}" },
                { id: "friedrice2", nameEn: "Fried Rice 2", nameEs: "Arroz Frito 2", emoji: "\u{1F373}" },
                { id: "dish", nameEn: "Dish", nameEs: "Platos", emoji: "\u{1F9FD}" },
                { id: "manager", nameEn: "Manager", nameEs: "Gerente", emoji: "\u{1F454}" },
                { id: "prep1", nameEn: "Prep 1", nameEs: "Prep 1", emoji: "\u{1F52A}" },
                { id: "prep2", nameEn: "Prep 2", nameEs: "Prep 2", emoji: "\u{1F52A}" },
                { id: "prep3", nameEn: "Prep 3", nameEs: "Prep 3", emoji: "\u{1F52A}" },
                { id: "prep4", nameEn: "Prep 4", nameEs: "Prep 4", emoji: "\u{1F52A}" }
            ];
            const DEFAULT_BREAK_WAVES = [
                { id: "wave1", time: "13:30" },
                { id: "wave2", time: "14:30" }
            ];
            // Skill stations for the matrix (unique skills, not position slots)
            const SKILL_STATIONS = [
                { id: "fry", nameEn: "Fry", emoji: "\u{1F35F}" },
                { id: "pho", nameEn: "Pho", emoji: "\u{1F372}" },
                { id: "grill", nameEn: "Grill", emoji: "\u{1F525}" },
                { id: "bao", nameEn: "Bao", emoji: "\u{1F95F}" },
                { id: "springroll", nameEn: "Spring Roll", emoji: "\u{1F32F}" },
                { id: "wok", nameEn: "Wok", emoji: "\u{1F958}" },
                { id: "bowls", nameEn: "Bowls", emoji: "\u{1F957}" },
                { id: "friedrice", nameEn: "Fried Rice", emoji: "\u{1F373}" },
                { id: "dish", nameEn: "Dish", emoji: "\u{1F9FD}" },
                { id: "prep", nameEn: "Prep", emoji: "\u{1F52A}" }
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
            const [newStationEmoji, setNewStationEmoji] = useState("\u{1F4CD}");
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
                return { id: w.id, time: t, displayTime: display, nameEn: `Wave ${i+1} \u{2014} ${display}`, nameEs: `Grupo ${i+1} \u{2014} ${display}` };
            });
            const [skillsMatrix, setSkillsMatrix] = useState({});
            const [showMatrix, setShowMatrix] = useState(false);

            // Labor percentage state (admin-only, from Toast scraper)
            const [laborData, setLaborData] = useState(null);
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

            // Listen to live labor data for current location
            useEffect(() => {
                const unsubLabor = onSnapshot(doc(db, "ops", "labor_" + storeLocation), (docSnap) => {
                    if (docSnap.exists()) {
                        setLaborData(docSnap.data());
                    } else {
                        setLaborData(null);
                    }
                });
                return () => unsubLabor();
            }, [storeLocation]);

            const saveStations = async (stations) => {
                try {
                    await setDoc(doc(db, "config", "stations"), { stations, updatedAt: new Date().toISOString() });
                } catch (err) { console.error("Error saving stations:", err); }
            };

            const addStation = () => {
                const name = newStationName.trim();
                if (!name) return;
                const id = name.toLowerCase().replace(/[^a-z0-9]/g, "") + "_" + Date.now();
                const station = { id, nameEn: name, nameEs: name, emoji: newStationEmoji || "\u{1F4CD}" };
                const updated = [...customStations, station];
                setCustomStations(updated);
                saveStations(updated);
                setNewStationName("");
                setNewStationEmoji("\u{1F4CD}");
            };

            const removeStation = (stationId) => {
                if (!confirm(language === "es" ? "¿Eliminar esta estación?" : "Remove this station?")) return;
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
                if (!confirm(language === "es" ? "¿Restaurar estaciones predeterminadas?" : "Reset stations to defaults?")) return;
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

            // Load break plan from Firestore {"\u{2014}"} keyed by selected date + location
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
                if (!confirm(language === "es" ? "¿Borrar todo el plan de breaks?" : "Clear entire break plan?")) return;
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
                            // Migrate morning/afternoon {"\u{2192}"} single "all" period
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
                        if (data.customInventory) {
                            // Merge Firestore custom items into the master INVENTORY_CATEGORIES
                            // so new items from inventory.js always appear
                            const merged = INVENTORY_CATEGORIES.map(masterCat => {
                                const savedCat = data.customInventory.find(sc => sc.name === masterCat.name);
                                if (!savedCat) return { ...masterCat, items: [...masterCat.items] };
                                // Build a set of IDs from the master list
                                const masterIds = new Set(masterCat.items.map(it => it.id));
                                // Start with all master items (preserves new additions)
                                const mergedItems = masterCat.items.map(mi => {
                                    const savedItem = savedCat.items.find(si => si.id === mi.id);
                                    // Keep any custom fields from saved (like changed vendor) but use master name/data as base
                                    return savedItem ? { ...mi, ...savedItem, name: mi.name, nameEs: mi.nameEs } : { ...mi };
                                });
                                // Add any custom items the user added that aren't in master
                                savedCat.items.forEach(si => {
                                    if (!masterIds.has(si.id)) mergedItems.push(si);
                                });
                                return { ...masterCat, items: mergedItems };
                            });
                            // Add any custom categories from Firestore not in master
                            data.customInventory.forEach(sc => {
                                if (!INVENTORY_CATEGORIES.find(mc => mc.name === sc.name)) {
                                    merged.push(sc);
                                }
                            });
                            setCustomInventory(merged);
                        }
                        setLastUpdated(prev => ({ ...prev, inventory: new Date(data.date).toLocaleString() }));
                    }
                });

                // Load vendor change log
                const unsubVendorLog = onSnapshot(doc(db, "ops", "vendorLog_" + storeLocation), (docSnap) => {
                    if (docSnap.exists()) {
                        setVendorChangeLog(docSnap.data().log || []);
                    }
                });

                // Load split list config (overrides + write-ins)
                const unsubSplit = onSnapshot(doc(db, "ops", "splitConfig_" + storeLocation), (docSnap) => {
                    if (docSnap.exists()) {
                        const data = docSnap.data();
                        if (data.overrides) setSplitOverrides(data.overrides);
                        if (data.writeIns) setSplitWriteIns(data.writeIns);
                    }
                });

                // Live vendor prices (from scrapers)
                const unsubSyscoPrices = onSnapshot(doc(db, "vendor_prices", "sysco"), (docSnap) => {
                    if (docSnap.exists()) {
                        setLivePrices(prev => ({ ...prev, sysco: docSnap.data() }));
                    }
                });

                // Listen for Sysco scrape trigger status updates
                const unsubSyscoTrigger = onSnapshot(doc(db, "vendor_prices", "sysco_trigger"), (docSnap) => {
                    if (docSnap.exists()) {
                        const data = docSnap.data();
                        if (data.status === "running") setSyscoTriggerStatus("running");
                        else if (data.status === "done") {
                            setSyscoTriggerStatus("done");
                            setTimeout(() => setSyscoTriggerStatus(null), 4000);
                        } else if (data.status === "error") {
                            setSyscoTriggerStatus("error");
                            setTimeout(() => setSyscoTriggerStatus(null), 5000);
                        } else if (!data.trigger) {
                            // idle state
                        }
                    }
                });

                return () => { unsubChecklist(); unsubInventorySnapshot(); unsubVendorLog(); unsubSplit(); unsubSyscoPrices(); unsubSyscoTrigger(); };
            }, [storeLocation]);

            // Midnight auto-reset: check every 60s if the date has changed
            useEffect(() => {
                let lastKnownDate = getTodayKey();
                const midnightInterval = setInterval(async () => {
                    const now = getTodayKey();
                    if (now !== lastKnownDate) {
                        lastKnownDate = now;
                        // Save current day's checklist to history before resetting
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
                        // Reset for new day
                        setChecks({});
                        setChecklistDate(now);
                        try {
                            await updateDoc(doc(db, "ops", "checklists2_" + storeLocation), { checks: {}, date: now, updatedAt: new Date().toISOString() });
                        } catch (err) { console.error("Midnight reset error:", err); }
                    }
                }, 60000); // Check every minute
                return () => clearInterval(midnightInterval);
            }, [storeLocation, checklistDate, checklistAssignments]);

            // {"\u{2500}"}{"\u{2500}"} PUSH NOTIFICATION SYSTEM {"\u{2500}"}{"\u{2500}"}
            // {"\u{2500}"}{"\u{2500}"} NOTIFICATION SYSTEM {"\u{2500}"}{"\u{2500}"}
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
                            const itemAssignees = Array.isArray(item.assignTo) ? item.assignTo : [item.assignTo];
                            if (!itemAssignees.includes(staffName)) return;
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
                                body: `"${a.taskName}" \u{2014} ${a.message}`,
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

            // Per-task assignment: toggle a staff member on/off a task's assignTo array
            const toggleTaskAssignee = async (taskIdx, staffMemberName) => {
                const updated = JSON.parse(JSON.stringify(customTasksRef.current));
                const item = updated[checklistSide][activePeriod][taskIdx];
                let current = [];
                if (item.assignTo) {
                    current = Array.isArray(item.assignTo) ? [...item.assignTo] : [item.assignTo];
                }
                const idx = current.indexOf(staffMemberName);
                if (idx >= 0) { current.splice(idx, 1); } else { current.push(staffMemberName); }
                if (current.length > 0) { item.assignTo = current; } else { delete item.assignTo; }
                setCustomTasks(updated);
                await saveChecklistState(checksRef.current, updated);
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
                else { alert(language === "es" ? "Contraseña incorrecta" : "Incorrect password"); }
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
                const newAssignArr = Array.isArray(newAssignTo) ? newAssignTo : newAssignTo ? [newAssignTo] : [];
                if (newAssignArr.length > 0) item.assignTo = newAssignArr;
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
                setNewTask(""); setNewRequirePhoto(false); setNewSubtasks([]); setNewCompleteBy(""); setNewAssignTo([]); setNewFollowUp(null); setShowAddForm(false);
            };

            const saveChecklistEdit = async (idx) => {
                if (!editTask.trim()) return;
                const updated = JSON.parse(JSON.stringify(customTasksRef.current));
                const item = updated[checklistSide][activePeriod][idx];
                item.task = editTask.trim();
                item.requirePhoto = editRequirePhoto;
                if (editCompleteBy) { item.completeBy = editCompleteBy; } else { delete item.completeBy; }
                const assignArr = Array.isArray(editAssignTo) ? editAssignTo : editAssignTo ? [editAssignTo] : [];
                if (assignArr.length > 0) { item.assignTo = assignArr; } else { delete item.assignTo; }
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
                setEditingIdx(null); setEditTask(""); setEditRequirePhoto(false); setEditSubtasks([]); setEditCompleteBy(""); setEditAssignTo([]); setEditFollowUp(null);
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
                if (!confirm(language === "es" ? "¿Guardar y reiniciar todas las tareas?" : "Save & reset all checklists?")) return;
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
                    items: cat.items.filter(i => cleanCounts[i.id]).map(i => ({ id: i.id, name: i.name, nameEs: i.nameEs || "", vendor: i.vendor || i.supplier || "", supplier: i.vendor || i.supplier || "", orderDay: i.orderDay || "", pack: i.pack || "", price: i.price || null }))
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
                const newItem = { id: catIdx + "-" + (maxId + 1), name: translated.name, nameEs: translated.nameEs, vendor: "", supplier: "", orderDay: "", pack: "", price: null, subcat: "" };
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
                    vendor: invNewSupplier.trim(),
                    supplier: invNewSupplier.trim(),
                    orderDay: invNewOrderDay,
                    pack: "",
                    price: null,
                    subcat: ""
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
                                ? { ...item, name: invEditName.trim(), nameEs: invEditNameEs.trim(), vendor: invEditSupplier.trim(), supplier: invEditSupplier.trim(), orderDay: invEditOrderDay }
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

            // Split list helpers
            const saveSplitConfig = async (overrides, writeIns) => {
                try {
                    await setDoc(doc(db, "ops", "splitConfig_" + storeLocation), { overrides, writeIns, date: new Date().toISOString() });
                } catch (err) { console.error("Error saving split config:", err); }
            };

            const moveSplitItem = async (itemId, toPerson) => {
                const updated = { ...splitOverrides, [itemId]: toPerson };
                setSplitOverrides(updated);
                setSplitMovingItem(null);
                await saveSplitConfig(updated, splitWriteIns);
            };

            const addSplitWriteIn = async (personName) => {
                const input = (splitWriteInValues[personName] || "").trim();
                if (!input) return;
                const existing = splitWriteIns[personName] || [];
                const newId = "sw-" + personName + "-" + Date.now();
                const updated = { ...splitWriteIns, [personName]: [...existing, { id: newId, name: input, count: 0 }] };
                setSplitWriteIns(updated);
                setSplitWriteInValues(prev => ({ ...prev, [personName]: "" }));
                await saveSplitConfig(splitOverrides, updated);
            };

            const removeSplitWriteIn = async (personName, itemId) => {
                const existing = splitWriteIns[personName] || [];
                const updated = { ...splitWriteIns, [personName]: existing.filter(i => i.id !== itemId) };
                setSplitWriteIns(updated);
                await saveSplitConfig(splitOverrides, updated);
            };

            const updateSplitWriteInCount = async (personName, itemId, newCount) => {
                const existing = splitWriteIns[personName] || [];
                const updated = { ...splitWriteIns, [personName]: existing.map(i => i.id === itemId ? { ...i, count: newCount } : i) };
                setSplitWriteIns(updated);
                await saveSplitConfig(splitOverrides, updated);
            };

            const toggleCatCollapse = (key) => {
                setCollapsedCats(prev => ({ ...prev, [key]: !prev[key] }));
            };

            // Parse pack string to total units for price-per-unit comparison
            const parsePackToUnits = (pack) => {
                if (!pack) return null;
                const p = pack.trim().toUpperCase();
                let m;
                // Direct weight: '50lb', '30 LB'
                m = p.match(/^(\d+\.?\d*)\s*(LB|LBS?)$/); if (m) return { total: parseFloat(m[1]), unit: "lb" };
                if (p === "LB") return { total: 1, unit: "lb" };
                if (p === "EA") return { total: 1, unit: "ea" };
                // Multiplied lb packs: '4/19 LBA', '3/17#AVG', '5/10#UP', '2/5 LB'
                m = p.match(/^(\d+)[/xX](\d+\.?\d*)\s*(LB|LBA|LBS?|#AVG|#UP|#)/); if (m) return { total: parseFloat(m[1]) * parseFloat(m[2]), unit: "lb" };
                // '5x5lb', '6/5lb'
                m = p.match(/^(\d+)[/xX](\d+\.?\d*)\s*LBS?$/); if (m) return { total: parseFloat(m[1]) * parseFloat(m[2]), unit: "lb" };
                // Gallons: '4/1 GA', '5 GA', '9/0.5GAL', '5gal'
                m = p.match(/^(\d+)[/xX](\d+\.?\d*)\s*GA[L]?$/); if (m) return { total: parseFloat(m[1]) * parseFloat(m[2]), unit: "gal" };
                m = p.match(/^(\d+\.?\d*)\s*GA[L]?$/); if (m) return { total: parseFloat(m[1]), unit: "gal" };
                // Liters: '5 LT'
                m = p.match(/^(\d+\.?\d*)\s*LT$/); if (m) return { total: parseFloat(m[1]), unit: "lt" };
                // Ounce packs to lb: '120/1.5 OZ', '48/3 OZ'
                m = p.match(/^(\d+)[/xX](\d+\.?\d*)\s*OZ$/); if (m) return { total: parseFloat(m[1]) * parseFloat(m[2]) / 16, unit: "lb" };
                // Count packs: '12/500 CT', '200 EA', '12/100 EA'
                m = p.match(/^(\d+)[/xX](\d+)\s*(CT|EA)$/); if (m) return { total: parseFloat(m[1]) * parseFloat(m[2]), unit: "ct" };
                m = p.match(/^(\d+)\s*(CT|EA)$/); if (m) return { total: parseFloat(m[1]), unit: "ct" };
                // Simple count: '1000', '400pc', '500pk', '2500p'
                m = p.match(/^(\d+)\s*(PC|PK|P|SET)?$/); if (m) return { total: parseFloat(m[1]), unit: "ct" };
                // Multiplied without unit: '10/25', '4x125'
                m = p.match(/^(\d+)[/xX](\d+)$/); if (m) return { total: parseFloat(m[1]) * parseFloat(m[2]), unit: "ct" };
                // '80/550CT', '1/500CT'
                m = p.match(/^(\d+)[/xX](\d+)\s*CT$/); if (m) return { total: parseFloat(m[1]) * parseFloat(m[2]), unit: "ct" };
                // Quarts: '12/1 QT'
                m = p.match(/^(\d+)[/xX](\d+\.?\d*)\s*QT$/); if (m) return { total: parseFloat(m[1]) * parseFloat(m[2]) * 0.25, unit: "gal" };
                // Rolls: '6 RL'
                m = p.match(/^(\d+)\s*RL$/); if (m) return { total: parseFloat(m[1]), unit: "rl" };
                // Feet: '3/1150FT'
                m = p.match(/^(\d+)[/xX](\d+)\s*FT$/); if (m) return { total: parseFloat(m[1]) * parseFloat(m[2]), unit: "ft" };
                // '1/40 LB'
                m = p.match(/^(\d+)[/xX](\d+\.?\d*)\s*LB$/); if (m) return { total: parseFloat(m[1]) * parseFloat(m[2]), unit: "lb" };
                return null;
            };

            // Get live scraped price for an item from a specific vendor
            const getLivePrice = (itemId, vendor) => {
                const vendorKey = (vendor || "").toLowerCase().replace(/\s+/g, '');
                const vendorMap = { "sysco": "sysco", "usfoods": "usfoods", "costcobusiness": "costco" };
                const key = vendorMap[vendorKey];
                if (!key || !livePrices[key] || !livePrices[key].prices) return null;
                const priceData = livePrices[key].prices[itemId];
                if (!priceData || !priceData.found || !priceData.price) return null;
                return priceData;
            };

            // Get vendor option label with live price if available
            const getVendorOptionLabel = (vo, itemId) => {
                const live = getLivePrice(itemId, vo.vendor);
                if (live && live.price) return `${vo.vendor} ($${live.price.toFixed(2)} LIVE)`;
                if (vo.price != null) return `${vo.vendor} ($${vo.price.toFixed(2)})`;
                return vo.vendor;
            };

            // Render live price badge for an item
            const renderLivePriceBadge = (itemId, item) => {
                const prefVendor = item.preferredVendor || item.vendor || "";
                const live = getLivePrice(itemId, prefVendor);
                if (!live) return null;
                const vendorLabel = prefVendor || "Vendor";
                return (
                    <span className="text-xs bg-green-100 text-green-700 px-1.5 py-0.5 rounded font-bold animate-pulse" title={`${vendorLabel} live: ${live.resultName || ""} | Pack: ${live.pack || "?"} | Updated: ${live.lastUpdated || "?"}`}>
                        {"\u{1F4E1}"} <span className="text-green-800 font-semibold">{vendorLabel}</span> ${live.price.toFixed(2)}{live.pack ? ` / ${live.pack}` : ""}
                    </span>
                );
            };

            // Find cheapest vendor by price per unit (not just raw price)
            const findCheapest = (item) => {
                if (!item.vendorOptions || item.vendorOptions.length < 2) return null;
                const withPrices = item.vendorOptions.filter(vo => vo.price && vo.price > 0);
                if (withPrices.length < 2) return null;
                // Calculate price per unit for each vendor
                const rated = withPrices.map(vo => {
                    const parsed = parsePackToUnits(vo.pack);
                    const perUnit = parsed && parsed.total > 0 ? vo.price / parsed.total : null;
                    return { ...vo, perUnit, unitType: parsed ? parsed.unit : null };
                });
                // Only compare vendors with the same unit type, or fallback to raw price
                const prefVendor = item.preferredVendor || item.vendor || "";
                const prefOption = rated.find(r => r.vendor === prefVendor);
                if (!prefOption) return null;
                // Find cheapest per-unit among same-unit vendors
                let cheapest = null;
                if (prefOption.perUnit !== null) {
                    const sameUnit = rated.filter(r => r.unitType === prefOption.unitType && r.perUnit !== null);
                    if (sameUnit.length > 1) {
                        sameUnit.sort((a, b) => a.perUnit - b.perUnit);
                        if (sameUnit[0].vendor !== prefVendor && sameUnit[0].perUnit < prefOption.perUnit * 0.95) {
                            cheapest = sameUnit[0];
                        }
                    }
                } else {
                    // No pack info — compare raw prices
                    const others = rated.filter(r => r.vendor !== prefVendor);
                    others.sort((a, b) => a.price - b.price);
                    if (others.length > 0 && others[0].price < (prefOption.price || Infinity) * 0.95) {
                        cheapest = others[0];
                    }
                }
                return cheapest;
            };

            const printInventory = () => {
                const counted = {};
                customInventory.forEach(cat => {
                    cat.items.forEach(item => {
                        if ((inventory[item.id] || 0) > 0) {
                            const v = item.preferredVendor || item.vendor || "Other";
                            if (!counted[v]) counted[v] = [];
                            counted[v].push({ ...item, count: inventory[item.id] });
                        }
                    });
                });
                const vendors = Object.keys(counted).sort();
                const now = new Date();
                const dateStr = now.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
                const timeStr = now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
                let html = `<html><head><title>DD Mau Order - ${dateStr}</title><style>
                    body{font-family:Arial,sans-serif;max-width:900px;margin:0 auto;padding:20px;color:#333}
                    h1{font-size:20px;color:#2F5496;margin-bottom:4px}
                    .date{font-size:12px;color:#888;margin-bottom:16px}
                    .vendor{background:#2F5496;color:white;padding:8px 12px;font-weight:bold;font-size:14px;margin-top:16px;border-radius:6px 6px 0 0}
                    table{width:100%;border-collapse:collapse;margin-bottom:12px}
                    th{background:#D6E4F0;padding:6px 10px;text-align:left;font-size:11px;color:#2F5496;border:1px solid #ccc}
                    td{padding:6px 10px;font-size:12px;border:1px solid #e0e0e0}
                    tr:nth-child(even){background:#f9f9f9}
                    .count{font-weight:bold;text-align:center;font-size:14px}
                    .pack{color:#666;font-size:11px}
                    .price{text-align:right;font-size:11px}
                    .cheaper{background:#fff3cd;font-size:10px;color:#856404}
                    .no-print{position:sticky;top:0;z-index:1000;background:#2F5496;padding:10px;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.3)}
                    .no-print button{padding:12px 24px;font-size:16px;font-weight:bold;border:none;border-radius:8px;cursor:pointer;margin:0 6px}
                    .btn-print{background:white;color:#2F5496} .btn-close{background:#ff4444;color:white}
                    @media print{body{padding:10px}h1{font-size:16px}.no-print{display:none !important}}
                </style></head><body>`;
                html += `<div class="no-print"><button class="btn-close" onclick="try{window.close()}catch(e){} setTimeout(function(){if(!window.closed){window.location.href='https://ddmauapp.github.io/dd-mau-portal/'}},300)">✕ Close</button><button class="btn-print" onclick="window.print()">🖨️ Print</button></div>`;
                html += `<h1>DD Mau Order Sheet</h1><div class="date">${dateStr} at ${timeStr} — ${storeLocation}</div>`;
                vendors.forEach(v => {
                    html += `<div class="vendor">${v} (${counted[v].length} items)</div>`;
                    html += `<table><tr><th>Item</th><th style="width:50px">Qty</th><th>Pack</th><th style="width:65px">Price</th><th style="width:65px">$/Unit</th><th>Cheaper Option</th><th style="width:30px">\u2713</th></tr>`;
                    counted[v].sort((a,b) => a.name.localeCompare(b.name)).forEach(item => {
                        const prefVendor = item.preferredVendor || item.vendor || "";
                        const prefOption = (item.vendorOptions || []).find(vo => vo.vendor === prefVendor);
                        const price = prefOption?.price || item.price;
                        const pack = prefOption?.pack || item.pack || "";
                        const parsed = parsePackToUnits(pack);
                        const perUnit = (price && parsed && parsed.total > 0) ? (price / parsed.total) : null;
                        const perUnitStr = perUnit !== null ? ("$" + perUnit.toFixed(2) + "/" + parsed.unit) : "";
                        const priceStr = price ? "$" + price.toFixed(2) : "";
                        const cheap = findCheapest(item);
                        let cheapStr = "";
                        if (cheap) {
                            const cParsed = parsePackToUnits(cheap.pack);
                            const cPerUnit = (cheap.price && cParsed && cParsed.total > 0) ? (cheap.price / cParsed.total) : null;
                            cheapStr = cheap.vendor;
                            if (cPerUnit !== null) cheapStr += " $" + cPerUnit.toFixed(2) + "/" + cParsed.unit;
                            else if (cheap.price) cheapStr += " $" + cheap.price.toFixed(2);
                            if (cheap.pack) cheapStr += " (" + cheap.pack + ")";
                        }
                        html += `<tr><td>${item.name}</td><td class="count">${item.count}</td><td class="pack">${pack}</td><td class="price">${priceStr}</td><td class="price">${perUnitStr}</td><td class="cheaper">${cheapStr}</td><td></td></tr>`;
                    });
                    html += `</table>`;
                });
                html += `</body></html>`;
                const w = window.open("", "_blank");
                w.document.write(html);
                w.document.close();
                w.print();
            };

            const changePreferredVendor = async (catIdx, itemIdx, newVendor) => {
                const item = customInventory[catIdx]?.items[itemIdx];
                if (!item) return;
                const oldVendor = item.preferredVendor || item.vendor || "";
                if (newVendor === oldVendor) return;
                const now = new Date();
                const logEntry = {
                    itemName: item.name,
                    itemId: item.id,
                    from: oldVendor,
                    to: newVendor,
                    changedBy: staffName,
                    date: now.toISOString(),
                    dateStr: now.toLocaleDateString("en-US", { month: "short", day: "numeric" }) + " " + now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
                };
                const updated = customInventory.map((cat, cIdx) =>
                    cIdx === catIdx
                        ? { ...cat, items: cat.items.map((it, iIdx) =>
                            iIdx === itemIdx ? { ...it, preferredVendor: newVendor } : it
                        )}
                        : cat
                );
                setCustomInventory(updated);
                const newLog = [logEntry, ...vendorChangeLog].slice(0, 50);
                setVendorChangeLog(newLog);
                try {
                    await setDoc(doc(db, "ops", "inventory_" + storeLocation), {
                        counts: inventory, customInventory: updated, countMeta: invCountMeta, date: now.toISOString()
                    });
                    await setDoc(doc(db, "ops", "vendorLog_" + storeLocation), { log: newLog }, { merge: true });
                } catch (err) { console.error("Error saving vendor change:", err); }
            };

            // Get tasks for current side + period
            // Helper: check if a staff name is in a task's assignTo (supports string or array)
            const isAssignedTo = (task, name) => {
                if (!task.assignTo) return false;
                if (Array.isArray(task.assignTo)) return task.assignTo.includes(name);
                return task.assignTo === name;
            };
            // Helper: get assignees as array
            const getAssignees = (task) => {
                if (!task.assignTo) return [];
                if (Array.isArray(task.assignTo)) return task.assignTo;
                return [task.assignTo];
            };

            const getCurrentTasks = () => {
                const all = (customTasks[checklistSide] && customTasks[checklistSide][activePeriod]) || [];
                const hasNoAssign = (t) => !t.assignTo || (Array.isArray(t.assignTo) && t.assignTo.length === 0);
                // Tag each task with its original index so edit/delete still works after filtering
                const tagged = all.map((t, i) => ({...t, _origIdx: i}));
                // Non-admin staff: only see tasks assigned to them or unassigned
                if (!currentIsAdmin) {
                    return tagged.filter(t => hasNoAssign(t) || isAssignedTo(t, staffName));
                }
                // Admin with filter active: show only tasks for that person (+ unassigned)
                if (taskFilter) {
                    return tagged.filter(t => hasNoAssign(t) || isAssignedTo(t, taskFilter));
                }
                return tagged;
            };
            // Get all tasks without filtering (for stats)
            const getAllTasks = () => {
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

            // Check if current staff member has opsAccess permission
            const currentStaffRecord = (staffList || []).find(s => s.name === staffName);
            const hasOpsAccess = currentIsAdmin || (currentStaffRecord && currentStaffRecord.opsAccess === true);

            if (!passwordEntered && !hasOpsAccess) {
                return (
                    <div className="flex flex-col items-center justify-center min-h-screen bg-gradient-to-b from-mint-50 to-white p-4">
                        <div className="bg-white rounded-lg border-2 border-mint-700 p-8 w-full max-w-sm">
                            <h2 className="text-2xl font-bold text-mint-700 mb-2">{"\u{1F510}"} {t("dailyOps", language)}</h2>
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
                const allTasks = getAllTasks();
                const periodStats = getPeriodStats(checklistSide, activePeriod);
                const overallStats = getCompletionStats(checklistSide);

                return (
                    <div className="space-y-3">
                        {/* FOH / BOH side selector */}
                        <div className="flex gap-2 mb-1">
                            {["FOH", "BOH"].map(side => {
                                const isActive = checklistSide === side;
                                const color = side === "FOH" ? "blue" : "amber";
                                return (
                                    <button key={side} onClick={() => { setChecklistSide(side); setActiveListIdx(0); setEditMode(false); setEditingIdx(null); setShowAddForm(false); setTaskFilter(""); }}
                                        className={`flex-1 py-2 px-2 rounded-xl font-bold text-sm transition border-2 ${isActive ? "bg-" + color + "-600 text-white border-" + color + "-600" : "bg-" + color + "-50 text-" + color + "-700 border-" + color + "-200"}`}>
                                        {side}
                                    </button>
                                );
                            })}
                        </div>

                        {/* Admin: filter by staff member */}
                        {currentIsAdmin && (
                            <div className="flex items-center gap-2 mb-2 bg-gray-50 rounded-lg p-2">
                                <span className="text-xs font-bold text-gray-500">{String.fromCodePoint(0x1F441)} {language === "es" ? "Ver" : "View"}:</span>
                                <select
                                    value={taskFilter}
                                    onChange={e => setTaskFilter(e.target.value)}
                                    className="flex-1 border border-gray-200 rounded-lg px-2 py-1.5 text-xs font-bold bg-white">
                                    <option value="">{language === "es" ? "\u{2014} Todos \u{2014}" : "\u{2014} All Staff \u{2014}"}</option>
                                    {(staffList || []).filter(s => s.location === storeLocation || s.location === "both").map(s => (
                                        <option key={s.id} value={s.name}>{s.name}</option>
                                    ))}
                                </select>
                                {taskFilter && (
                                    <button onClick={() => setTaskFilter("")} className="text-xs text-red-500 font-bold px-1">{String.fromCodePoint(0x2715)}</button>
                                )}
                            </div>
                        )}

                        {/* Non-admin sees their assignment badge */}
                        {!currentIsAdmin && (
                            <div className="text-center text-xs font-bold py-1.5 rounded-lg mb-2 bg-green-50 text-green-700 border border-green-200">
                                {language === "es" ? "Mostrando tus tareas asignadas" : "Showing your assigned tasks"}
                            </div>
                        )}

                        {/* Overall progress bar */}
                        <div className="bg-gray-100 rounded-lg p-3 mb-2">
                            <div className="flex justify-between text-xs font-bold text-gray-600 mb-1">
                                <span>{checklistSide} {"\u{2014}"} {language === "es" ? "Progreso del día" : "Day progress"}</span>
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
                                    {editMode ? (language === "es" ? "Listo" : "Done") : "\u{270F}\u{FE0F} " + (language === "es" ? "Editar" : "Edit")}
                                </button>
                            )}
                        </div>

                        {/* Task list */}
                        {tasks.length === 0 && !editMode && (
                            <div className="text-center py-6 text-gray-400 text-sm">
                                {language === "es" ? "No hay tareas para este período" : "No tasks for this period"}
                            </div>
                        )}

                        {tasks.map((item, idx) => {
                            const origIdx = item._origIdx !== undefined ? item._origIdx : idx;
                            const hasSubtasks = item.subtasks && item.subtasks.length > 0;
                            const taskComplete = isTaskComplete(item);
                            const photoUrl = checks[currentPrefix + item.id + "_photo"];
                            const photoNeeded = item.requirePhoto && !photoUrl;
                            const assignees = getAssignees(item);

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

                            if (editingIdx === origIdx) {
                                return (
                                    <div key={item.id} className="p-3 rounded-lg border-2 border-blue-300 bg-blue-50">
                                        <input type="text" value={editTask} onChange={e => setEditTask(e.target.value)}
                                            className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm mb-2 focus:outline-none focus:border-blue-400" autoFocus />
                                        {/* Complete by time */}
                                        <div className="flex items-center gap-2 mb-2">
                                            <label className="text-xs font-bold text-gray-600">{"\u{23F0}"} {language === "es" ? "Completar antes de:" : "Complete by:"}</label>
                                            <input type="time" value={editCompleteBy} onChange={e => setEditCompleteBy(e.target.value)}
                                                className="border border-gray-200 rounded px-2 py-1 text-xs" />
                                            {editCompleteBy && <button onClick={() => setEditCompleteBy("")} className="text-red-400 text-xs">{"\u{2715}"}</button>}
                                        </div>
                                        {/* Assign to (always visible) */}
                                        <div className="flex items-center gap-2 mb-2">
                                            <label className="text-xs font-bold text-gray-600">{String.fromCodePoint(0x1F464)} {language === "es" ? "Asignar a:" : "Assign to:"}</label>
                                            <select value="" onChange={e => { if (e.target.value) { const cur = editAssignTo ? (Array.isArray(editAssignTo) ? editAssignTo : [editAssignTo]) : []; if (!cur.includes(e.target.value)) setEditAssignTo([...cur, e.target.value]); } }}
                                                className="border border-gray-200 rounded px-2 py-1 text-xs flex-1">
                                                <option value="">{language === "es" ? "\u{2014} Agregar persona \u{2014}" : "\u{2014} Add person \u{2014}"}</option>
                                                {(staffList || []).filter(s => s.location === storeLocation || s.location === "both").filter(s => !(Array.isArray(editAssignTo) ? editAssignTo : editAssignTo ? [editAssignTo] : []).includes(s.name)).map(s => (
                                                    <option key={s.id} value={s.name}>{s.name}</option>
                                                ))}
                                            </select>
                                        </div>
                                        {(Array.isArray(editAssignTo) ? editAssignTo : editAssignTo ? [editAssignTo] : []).length > 0 && (
                                            <div className="flex flex-wrap gap-1 mb-2">
                                                {(Array.isArray(editAssignTo) ? editAssignTo : [editAssignTo]).map(name => (
                                                    <span key={name} className="inline-flex items-center gap-1 px-2 py-0.5 bg-blue-100 text-blue-700 rounded-full text-xs font-bold">
                                                        {name.split(" ")[0]}
                                                        <button onClick={() => { const cur = Array.isArray(editAssignTo) ? editAssignTo : [editAssignTo]; setEditAssignTo(cur.filter(n => n !== name)); }}
                                                            className="text-blue-400 hover:text-red-500">{String.fromCodePoint(0x2715)}</button>
                                                    </span>
                                                ))}
                                            </div>
                                        )}
                                        {/* Photo toggle */}
                                        <label className="flex items-center gap-2 mb-2 text-xs cursor-pointer">
                                            <input type="checkbox" checked={editRequirePhoto} onChange={e => setEditRequirePhoto(e.target.checked)} className="w-4 h-4" />
                                            <span className="font-bold text-gray-600">{"\u{1F4F8}"} {language === "es" ? "Requiere foto" : "Require photo"}</span>
                                        </label>
                                        {/* Subtasks editor */}
                                        <div className="mb-2">
                                            <p className="text-xs font-bold text-gray-500 mb-1">{language === "es" ? "Subtareas" : "Subtasks"}</p>
                                            {editSubtasks.map((sub, si) => (
                                                <div key={si} className="flex gap-1 mb-1">
                                                    <input className="flex-1 border border-gray-200 rounded px-2 py-1 text-xs" value={sub.task}
                                                        onChange={e => { const u = [...editSubtasks]; u[si] = {...u[si], task: e.target.value}; setEditSubtasks(u); }}
                                                        placeholder={(language === "es" ? "Subtarea " : "Subtask ") + (si+1)} />
                                                    <button onClick={() => setEditSubtasks(editSubtasks.filter((_,i) => i !== si))} className="text-red-400 text-xs px-1">{"\u{2715}"}</button>
                                                </div>
                                            ))}
                                            <button onClick={() => setEditSubtasks([...editSubtasks, {id: "", task: ""}])}
                                                className="text-xs text-mint-700 font-bold">+ {language === "es" ? "Agregar subtarea" : "Add subtask"}</button>
                                        </div>
                                        {/* Follow-up question editor */}
                                        <div className="mb-2 border-t border-gray-200 pt-2">
                                            <div className="flex items-center justify-between mb-1">
                                                <p className="text-xs font-bold text-gray-500">{"\u{2753}"} {language === "es" ? "Pregunta al completar" : "Follow-up question"}</p>
                                                {!editFollowUp ? (
                                                    <button onClick={() => setEditFollowUp({ type: "dropdown", question: "", options: [""] })}
                                                        className="text-xs text-blue-600 font-bold">+ {language === "es" ? "Agregar" : "Add"}</button>
                                                ) : (
                                                    <button onClick={() => setEditFollowUp(null)} className="text-red-400 text-xs">{"\u{2715}"} {language === "es" ? "Quitar" : "Remove"}</button>
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
                                                                        placeholder={(language === "es" ? "Opción " : "Option ") + (oi+1)} />
                                                                    <button onClick={() => { const u = editFollowUp.options.filter((_,i) => i !== oi); setEditFollowUp({...editFollowUp, options: u}); }}
                                                                        className="text-red-400 text-xs px-1">{"\u{2715}"}</button>
                                                                </div>
                                                            ))}
                                                            <button onClick={() => setEditFollowUp({...editFollowUp, options: [...(editFollowUp.options || []), ""]})}
                                                                className="text-xs text-blue-600 font-bold">+ {language === "es" ? "Agregar opción" : "Add option"}</button>
                                                        </div>
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <button onClick={() => saveChecklistEdit(origIdx)}
                                                className="px-3 py-1.5 bg-blue-600 text-white text-xs font-bold rounded-lg">{language === "es" ? "Guardar" : "Save"}</button>
                                            <button onClick={() => { setEditingIdx(null); setEditSubtasks([]); setEditCompleteBy(""); setEditAssignTo([]); setEditFollowUp(null); }}
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
                                                    {item.requirePhoto && <span className="text-xs">{"\u{1F4F8}"}</span>}
                                                    {item.completeBy && (
                                                        <span className={`text-xs font-bold px-1.5 py-0.5 rounded-full whitespace-nowrap ${
                                                            taskComplete ? "bg-green-100 text-green-600"
                                                            : taskUrgency === "overdue" ? "bg-red-600 text-white"
                                                            : taskUrgency === "warning" ? "bg-yellow-400 text-yellow-900"
                                                            : "bg-orange-100 text-orange-600"
                                                        }`}>
                                                            {taskUrgency === "overdue" ? "\u{1F6A8}" : "\u{23F0}"} {item.completeBy.replace(/^0/, "")}
                                                        </span>
                                                    )}
                                                </div>
                                                {/* Assignee chips */}
                                                {assignees.length > 0 && (
                                                    <div className="flex flex-wrap gap-1 mt-1">
                                                        {assignees.map(name => (
                                                            <span key={name} className="inline-flex items-center gap-0.5 px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded-full text-[10px] font-bold">
                                                                {String.fromCodePoint(0x1F464)} {name.split(" ")[0]}
                                                                {currentIsAdmin && editMode && (
                                                                    <button onClick={(e) => { e.stopPropagation(); toggleTaskAssignee(origIdx, name); }}
                                                                        className="text-blue-400 hover:text-red-500 ml-0.5">{String.fromCodePoint(0x2715)}</button>
                                                                )}
                                                            </span>
                                                        ))}
                                                    </div>
                                                )}
                                                {/* Quick assign button for admin (in edit mode) */}
                                                {currentIsAdmin && editMode && (
                                                    <div className="mt-1">
                                                        <select value="" onChange={e => { if (e.target.value) toggleTaskAssignee(origIdx, e.target.value); }}
                                                            className="border border-gray-200 rounded px-1 py-0.5 text-[10px] bg-white">
                                                            <option value="">+ {language === "es" ? "Asignar" : "Assign"}</option>
                                                            {(staffList || []).filter(s => s.location === storeLocation || s.location === "both").filter(s => !assignees.includes(s.name)).map(s => (
                                                                <option key={s.id} value={s.name}>{s.name}</option>
                                                            ))}
                                                        </select>
                                                    </div>
                                                )}
                                                {/* Completed by info {"\u{2014}"} for tasks without subtasks */}
                                                {!hasSubtasks && checks[currentPrefix + item.id] && checks[currentPrefix + item.id + "_by"] && (
                                                    <p className="text-xs text-green-600 mt-0.5">
                                                        {String.fromCodePoint(0x2713)} {checks[currentPrefix + item.id + "_by"]} {String.fromCodePoint(0x2014)} {checks[currentPrefix + item.id + "_at"]}
                                                    </p>
                                                )}
                                            </div>
                                        </div>
                                        {editMode && (
                                            <div className="flex flex-col gap-1 pr-2">
                                                <button onClick={() => { setEditingIdx(origIdx); setEditTask(item.task); setEditRequirePhoto(!!item.requirePhoto); setEditCompleteBy(item.completeBy || ""); setEditAssignTo(item.assignTo ? (Array.isArray(item.assignTo) ? [...item.assignTo] : [item.assignTo]) : []); setEditFollowUp(item.followUp ? {...item.followUp, options: item.followUp.options ? [...item.followUp.options] : []} : null); setEditSubtasks(item.subtasks ? item.subtasks.map(s => ({...s})) : []); setShowAddForm(false); }}
                                                    className="p-1.5 rounded-lg bg-blue-50 text-blue-600 hover:bg-blue-100">{String.fromCodePoint(0x270F, 0xFE0F)}</button>
                                                <button onClick={() => deleteChecklistTask(origIdx)}
                                                    className="p-1.5 rounded-lg bg-red-50 text-red-600 hover:bg-red-100">{"\u{1F5D1}"}{"\u{FE0F}"}</button>
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
                                                            {"\u{2713}"} {checks[currentPrefix + sub.id + "_by"]} {"\u{2014}"} {checks[currentPrefix + sub.id + "_at"]}
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
                                                        <span className="text-xs text-green-600 font-bold">{"\u{2713}"} {language === "es" ? "Foto tomada" : "Photo taken"}</span>
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
                                                            ? (language === "es" ? "\u{23F3} Subiendo..." : "\u{23F3} Uploading...")
                                                            : (language === "es" ? "\u{1F4F8} Tomar foto" : "\u{1F4F8} Take photo")}
                                                    </button>
                                                </div>
                                            )}
                                        </div>
                                    )}
                                    {/* Follow-up question prompt {"\u{2014}"} shows when task is completed */}
                                    {item.followUp && item.followUp.question && (showFollowUpFor === item.id || (taskComplete && !checks[currentPrefix + item.id + "_followUp"])) && (
                                        <div className="mx-3 mb-3 p-3 bg-blue-50 border-2 border-blue-300 rounded-xl">
                                            <p className="text-sm font-bold text-blue-800 mb-2">{"\u{2753}"} {item.followUp.question}</p>
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
                                                        {"\u{2713}"}
                                                    </button>
                                                </div>
                                            )}
                                        </div>
                                    )}
                                    {/* Show saved answer */}
                                    {item.followUp && checks[currentPrefix + item.id + "_followUp"] && showFollowUpFor !== item.id && (
                                        <div className="mx-3 mb-2 px-3 py-1.5 bg-gray-50 rounded-lg border border-gray-200">
                                            <p className="text-xs text-gray-500">{"\u{2753}"} {item.followUp.question}</p>
                                            <p className="text-sm font-bold text-gray-700">{"\u{1F4AC}"} {checks[currentPrefix + item.id + "_followUp"]}</p>
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
                                    <label className="text-xs font-bold text-gray-600">{"\u{23F0}"} {language === "es" ? "Completar antes de:" : "Complete by:"}</label>
                                    <input type="time" value={newCompleteBy} onChange={e => setNewCompleteBy(e.target.value)}
                                        className="border border-gray-200 rounded px-2 py-1 text-xs" />
                                    {newCompleteBy && <button onClick={() => setNewCompleteBy("")} className="text-red-400 text-xs">{"\u{2715}"}</button>}
                                </div>
                                {/* Assign to (always visible, multi-select) */}
                                <div className="flex items-center gap-2 mb-2">
                                    <label className="text-xs font-bold text-gray-600">{String.fromCodePoint(0x1F464)} {language === "es" ? "Asignar a:" : "Assign to:"}</label>
                                    <select value="" onChange={e => { if (e.target.value) { const cur = newAssignTo ? (Array.isArray(newAssignTo) ? newAssignTo : [newAssignTo]) : []; if (!cur.includes(e.target.value)) setNewAssignTo([...cur, e.target.value]); } }}
                                        className="border border-gray-200 rounded px-2 py-1 text-xs flex-1">
                                        <option value="">{language === "es" ? "\u{2014} Agregar persona \u{2014}" : "\u{2014} Add person \u{2014}"}</option>
                                        {(staffList || []).filter(s => s.location === storeLocation || s.location === "both").filter(s => !(Array.isArray(newAssignTo) ? newAssignTo : newAssignTo ? [newAssignTo] : []).includes(s.name)).map(s => (
                                            <option key={s.id} value={s.name}>{s.name}</option>
                                        ))}
                                    </select>
                                </div>
                                {(Array.isArray(newAssignTo) ? newAssignTo : newAssignTo ? [newAssignTo] : []).length > 0 && (
                                    <div className="flex flex-wrap gap-1 mb-2">
                                        {(Array.isArray(newAssignTo) ? newAssignTo : [newAssignTo]).map(name => (
                                            <span key={name} className="inline-flex items-center gap-1 px-2 py-0.5 bg-blue-100 text-blue-700 rounded-full text-xs font-bold">
                                                {name.split(" ")[0]}
                                                <button onClick={() => { const cur = Array.isArray(newAssignTo) ? newAssignTo : [newAssignTo]; setNewAssignTo(cur.filter(n => n !== name)); }}
                                                    className="text-blue-400 hover:text-red-500">{String.fromCodePoint(0x2715)}</button>
                                            </span>
                                        ))}
                                    </div>
                                )}
                                {/* Photo toggle */}
                                <label className="flex items-center gap-2 mb-2 text-xs cursor-pointer">
                                    <input type="checkbox" checked={newRequirePhoto} onChange={e => setNewRequirePhoto(e.target.checked)} className="w-4 h-4" />
                                    <span className="font-bold text-gray-600">{"\u{1F4F8}"} {language === "es" ? "Requiere foto" : "Require photo"}</span>
                                </label>
                                {/* Subtasks editor */}
                                <div className="mb-2">
                                    <p className="text-xs font-bold text-gray-500 mb-1">{language === "es" ? "Subtareas" : "Subtasks"}</p>
                                    {newSubtasks.map((sub, si) => (
                                        <div key={si} className="flex gap-1 mb-1">
                                            <input className="flex-1 border border-gray-200 rounded px-2 py-1 text-xs" value={sub.task}
                                                onChange={e => { const u = [...newSubtasks]; u[si] = {...u[si], task: e.target.value}; setNewSubtasks(u); }}
                                                placeholder={(language === "es" ? "Subtarea " : "Subtask ") + (si+1)} />
                                            <button onClick={() => setNewSubtasks(newSubtasks.filter((_,i) => i !== si))} className="text-red-400 text-xs px-1">{"\u{2715}"}</button>
                                        </div>
                                    ))}
                                    <button onClick={() => setNewSubtasks([...newSubtasks, {id: "", task: ""}])}
                                        className="text-xs text-mint-700 font-bold">+ {language === "es" ? "Agregar subtarea" : "Add subtask"}</button>
                                </div>
                                {/* Follow-up question editor */}
                                <div className="mb-2 border-t border-gray-200 pt-2">
                                    <div className="flex items-center justify-between mb-1">
                                        <p className="text-xs font-bold text-gray-500">{"\u{2753}"} {language === "es" ? "Pregunta al completar" : "Follow-up question"}</p>
                                        {!newFollowUp ? (
                                            <button onClick={() => setNewFollowUp({ type: "dropdown", question: "", options: [""] })}
                                                className="text-xs text-blue-600 font-bold">+ {language === "es" ? "Agregar" : "Add"}</button>
                                        ) : (
                                            <button onClick={() => setNewFollowUp(null)} className="text-red-400 text-xs">{"\u{2715}"} {language === "es" ? "Quitar" : "Remove"}</button>
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
                                                                placeholder={(language === "es" ? "Opción " : "Option ") + (oi+1)} />
                                                            <button onClick={() => { const u = newFollowUp.options.filter((_,i) => i !== oi); setNewFollowUp({...newFollowUp, options: u}); }}
                                                                className="text-red-400 text-xs px-1">{"\u{2715}"}</button>
                                                        </div>
                                                    ))}
                                                    <button onClick={() => setNewFollowUp({...newFollowUp, options: [...(newFollowUp.options || []), ""]})}
                                                        className="text-xs text-blue-600 font-bold">+ {language === "es" ? "Agregar opción" : "Add option"}</button>
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

                        {/* Reset button {"\u{2014}"} admin only */}
                        {currentIsAdmin && (
                            <button onClick={resetAllChecklists}
                                className="w-full mt-4 py-3 rounded-xl font-bold text-sm bg-red-50 text-red-600 border-2 border-red-200 hover:bg-red-100 transition">
                                {language === "es" ? "\u{1F4BE} Guardar y Reiniciar Checklists" : "\u{1F4BE} Save & Reset Checklists"}
                            </button>
                        )}
                    </div>
                );
            };

            return (
                <div className="p-4 pb-24">
                    <h2 className="text-2xl font-bold text-mint-700 mb-4">{"\u{1F4CB}"} {t("dailyOps", language)}</h2>

                    {/* Labor % Card — visible to all staff, percentage only (no dollar amounts) */}
                    {laborData && laborData.laborPercent !== undefined && (() => {
                        const pct = laborData.laborPercent;
                        const updatedAt = laborData.updatedAt ? new Date(laborData.updatedAt) : null;
                        const minutesAgo = updatedAt ? Math.round((Date.now() - updatedAt.getTime()) / 60000) : null;
                        const isStale = minutesAgo !== null && minutesAgo > 10;
                        const color = pct <= 22 ? { bg: "bg-emerald-50", border: "border-emerald-400", text: "text-emerald-700", emoji: "\u{2705}" }
                                    : pct <= 27 ? { bg: "bg-amber-50", border: "border-amber-400", text: "text-amber-700", emoji: "\u{26A0}\u{FE0F}" }
                                    : { bg: "bg-red-50", border: "border-red-400", text: "text-red-700", emoji: "\u{1F534}" };
                        return (
                            <div className={`${color.bg} border-2 ${color.border} rounded-2xl p-4 mb-4 shadow-sm`}>
                                <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-3">
                                        <span className="text-2xl">{color.emoji}</span>
                                        <div>
                                            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">{t("laborPercent", language)}</p>
                                            <p className={`text-3xl font-black tabular-nums ${color.text}`}>{pct.toFixed(1)}%</p>
                                        </div>
                                    </div>
                                    <div className="text-right">
                                        <p className={`text-xs ${isStale ? "text-red-500 font-bold" : "text-gray-400"}`}>
                                            {isStale ? "\u{26A0}\u{FE0F} " : ""}
                                            {updatedAt ? updatedAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "--"}
                                        </p>
                                        {minutesAgo !== null && (
                                            <p className="text-[10px] text-gray-400">{minutesAgo === 0 ? (language === "es" ? "ahora" : "just now") : `${minutesAgo} min`}</p>
                                        )}
                                    </div>
                                </div>
                                {/* Progress bar */}
                                <div className="mt-3 relative">
                                    <div className="w-full h-3 bg-gray-200 rounded-full overflow-hidden">
                                        <div className="h-full rounded-full transition-all duration-500"
                                            style={{
                                                width: Math.min(pct / 37.5 * 100, 100) + "%",
                                                backgroundColor: pct <= 22 ? "#10b981" : pct <= 27 ? "#f59e0b" : "#ef4444"
                                            }} />
                                    </div>
                                    {/* Target marker at 25% */}
                                    <div className="absolute top-0 h-3 border-r-2 border-gray-600" style={{ left: (25 / 37.5 * 100) + "%" }}>
                                        <div className="absolute -top-4 -translate-x-1/2 text-[9px] font-bold text-gray-500">25%</div>
                                    </div>
                                </div>
                            </div>
                        );
                    })()}

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
                        <button onClick={() => { setActiveTab("prep"); setEditMode(false); }}
                            className={`flex-1 py-2 rounded-lg font-bold transition ${activeTab === "prep" ? "bg-orange-600 text-white" : "bg-gray-200 text-gray-700"}`}>
                            {language === "es" ? "Prep" : "Prep"}
                        </button>
                    </div>

                    {/* {"\u{2500}"}{"\u{2500}"} TASK DEADLINE ALERTS {"\u{2500}"}{"\u{2500}"} */}
                    {activeAlerts.length > 0 && (
                        <div className="space-y-2 mb-3">
                            {activeAlerts.map(a => (
                                <div key={a.key} className={`flex items-center gap-2 px-3 py-2.5 rounded-xl border-2 shadow-sm animate-pulse ${
                                    a.type === "overdue" ? "bg-red-50 border-red-300" : "bg-yellow-50 border-yellow-300"
                                }`}>
                                    <span className="text-xl">{a.type === "overdue" ? "\u{1F6A8}" : "\u{23F0}"}</span>
                                    <div className="flex-1 min-w-0">
                                        <p className={`text-sm font-bold ${a.type === "overdue" ? "text-red-700" : "text-yellow-800"}`}>
                                            {a.taskName}
                                        </p>
                                        <p className={`text-xs ${a.type === "overdue" ? "text-red-500" : "text-yellow-600"}`}>
                                            {a.type === "overdue"
                                                ? (language === "es" ? `Venció a las ${a.timeStr} \u{2014} ${a.message}` : `Due at ${a.timeStr} \u{2014} ${a.message}`)
                                                : (language === "es" ? `Vence a las ${a.timeStr} \u{2014} ${a.message}` : `Due at ${a.timeStr} \u{2014} ${a.message}`)
                                            }
                                        </p>
                                    </div>
                                    <button onClick={() => dismissAlert(a.key)}
                                        className={`text-xs font-bold px-2 py-1 rounded-lg ${a.type === "overdue" ? "bg-red-200 text-red-700" : "bg-yellow-200 text-yellow-700"}`}>
                                        {"\u{2715}"}
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}

                    {activeTab === "checklist" && renderChecklist()}

                    {activeTab === "inventory" && (
                        <div className="space-y-3">
                            {/* ── TOP TOOLBAR ── */}
                            <div className="flex items-center justify-between gap-2">
                                <div className="flex items-center gap-1.5">
                                    <button onClick={() => setInvViewMode("category")}
                                        className={`px-3 py-1.5 rounded-lg text-xs font-bold transition ${invViewMode === "category" ? "bg-mint-700 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}>
                                        {language === "es" ? "Categoría" : "Category"}
                                    </button>
                                    <button onClick={() => setInvViewMode("vendor")}
                                        className={`px-3 py-1.5 rounded-lg text-xs font-bold transition ${invViewMode === "vendor" ? "bg-mint-700 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}>
                                        {language === "es" ? "Proveedor" : "Vendor"}
                                    </button>
                                    <button onClick={() => setInvViewMode("split")}
                                        className={`px-3 py-1.5 rounded-lg text-xs font-bold transition ${invViewMode === "split" ? "bg-purple-700 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}>
                                        {language === "es" ? "Dividir" : "Split"}
                                    </button>
                                    <button onClick={() => setInvViewMode("pricing")}
                                        className={`px-3 py-1.5 rounded-lg text-xs font-bold transition ${invViewMode === "pricing" ? "bg-blue-700 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}>
                                        {language === "es" ? "Precios" : "Pricing"}
                                    </button>
                                </div>
                                <div className="flex items-center gap-1.5">
                                    <button onClick={printInventory} title="Print"
                                        className="w-9 h-9 rounded-lg bg-gray-100 text-gray-600 flex items-center justify-center hover:bg-blue-50 hover:text-blue-700 transition text-lg">
                                        {"\u{1F5A8}"}
                                    </button>
                                    <button onClick={() => { setInvEditMode(!invEditMode); setInvEditingIdx(null); setInvShowAddForm(null); }}
                                        className={`px-3 py-1.5 rounded-lg text-xs font-bold transition ${invEditMode ? "bg-green-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}>
                                        {invEditMode ? (language === "es" ? "Listo" : "Done") : (language === "es" ? "Editar" : "Edit")}
                                    </button>
                                </div>
                            </div>

                            {/* ── LIVE PRICES INDICATOR ── */}
                            {livePrices.sysco && livePrices.sysco.lastScraped && (
                                <div className="flex items-center gap-2 px-2 py-1 bg-green-50 rounded-lg border border-green-200">
                                    <span className="text-xs text-green-700 font-medium">{"\u{1F4E1}"} {language === "es" ? "Precios Sysco en vivo" : "Sysco live prices"}</span>
                                    <span className="text-xs text-green-500">{livePrices.sysco.foundCount || 0}/{livePrices.sysco.totalItems || 0} items</span>
                                    <span className="text-xs text-gray-400 ml-auto">{language === "es" ? "Actualizado" : "Updated"}: {new Date(livePrices.sysco.lastScraped).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
                                </div>
                            )}

                            {/* ── SEARCH BAR ── */}
                            {!invEditMode && (
                                <div className="relative">
                                    <input type="text" value={invSearch} onChange={e => setInvSearch(e.target.value)}
                                        placeholder={language === "es" ? "\u{1F50D} Buscar artículo o proveedor..." : "\u{1F50D} Search items or vendor..."}
                                        className="w-full px-4 py-2.5 border-2 border-gray-200 rounded-xl text-sm focus:outline-none focus:border-mint-700 bg-white" />
                                    {invSearch && (
                                        <button onClick={() => setInvSearch("")}
                                            className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-lg">{"\u{2715}"}</button>
                                    )}
                                </div>
                            )}

                            {/* ── CART SUMMARY ── */}
                            {!invEditMode && (() => {
                                const itemCount = Object.values(inventory).filter(v => v > 0).length;
                                const totalQty = Object.values(inventory).reduce((sum, v) => sum + (v > 0 ? v : 0), 0);
                                if (itemCount === 0) return null;
                                return (
                                    <div className="bg-mint-50 border border-mint-200 rounded-xl px-3 py-2 flex items-center justify-between">
                                        <button onClick={() => setShowCart(true)} className="text-sm font-bold text-mint-700 flex items-center gap-1 hover:text-mint-900 transition">
                                            {"\u{1F6D2}"} {totalQty} {language === "es" ? "total" : "total"} ({itemCount} {language === "es" ? "artículos" : "items"})
                                            <span className="text-xs text-mint-500 ml-1">{language === "es" ? "ver ▸" : "view ▸"}</span>
                                        </button>
                                        <button onClick={() => setInvShowOnlyCounted(!invShowOnlyCounted)}
                                            className={`text-xs font-bold px-2 py-1 rounded-lg transition ${invShowOnlyCounted ? "bg-mint-700 text-white" : "bg-mint-100 text-mint-700 hover:bg-mint-200"}`}>
                                            {invShowOnlyCounted ? (language === "es" ? "Ver Todo" : "Show All") : (language === "es" ? "Solo Contados" : "Counted Only")}
                                        </button>
                                    </div>
                                );
                            })()}

                            {/* ── CART MODAL ── */}
                            {showCart && (() => {
                                const cartVendors = {};
                                customInventory.forEach(cat => {
                                    cat.items.forEach(item => {
                                        const qty = inventory[item.id] || 0;
                                        if (qty > 0) {
                                            const v = item.preferredVendor || item.vendor || "Other";
                                            if (!cartVendors[v]) cartVendors[v] = [];
                                            cartVendors[v].push({ ...item, count: qty, categoryName: cat.name });
                                        }
                                    });
                                });
                                const vendors = Object.keys(cartVendors).sort();
                                const totalItems = vendors.reduce((s, v) => s + cartVendors[v].length, 0);
                                const totalQty = vendors.reduce((s, v) => s + cartVendors[v].reduce((a, i) => a + i.count, 0), 0);

                                return (
                                    <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-end sm:items-center justify-center" onClick={() => setShowCart(false)}>
                                        <div className="bg-white w-full max-w-lg max-h-[85vh] rounded-t-2xl sm:rounded-2xl overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}>
                                            {/* Header */}
                                            <div className="bg-mint-700 text-white px-4 py-3 flex items-center justify-between flex-shrink-0">
                                                <h3 className="font-bold text-lg">{"\u{1F6D2}"} {language === "es" ? "Carrito" : "Cart"} — {totalItems} {language === "es" ? "artículos" : "items"}, {totalQty} {language === "es" ? "total" : "total"}</h3>
                                                <button onClick={() => setShowCart(false)} className="w-8 h-8 rounded-full bg-white bg-opacity-20 flex items-center justify-center text-white font-bold hover:bg-opacity-30 transition">{"\u{2715}"}</button>
                                            </div>
                                            {/* Cart items grouped by vendor */}
                                            <div className="flex-1 overflow-y-auto">
                                                {vendors.map(v => (
                                                    <div key={v}>
                                                        <div className="bg-blue-600 text-white px-4 py-2 font-bold text-sm flex justify-between items-center">
                                                            <span>{v}</span>
                                                            <span className="text-xs bg-white bg-opacity-20 px-2 py-0.5 rounded-full">{cartVendors[v].length} {language === "es" ? "artículos" : "items"}</span>
                                                        </div>
                                                        <div className="divide-y divide-gray-100">
                                                            {cartVendors[v].sort((a, b) => a.name.localeCompare(b.name)).map(item => {
                                                                const cheap = findCheapest(item);
                                                                let cheapLabel = "";
                                                                if (cheap) {
                                                                    const cParsed = parsePackToUnits(cheap.pack);
                                                                    const cPerUnit = (cheap.price && cParsed && cParsed.total > 0) ? (cheap.price / cParsed.total) : null;
                                                                    cheapLabel = cheap.vendor;
                                                                    if (cPerUnit !== null) cheapLabel += " $" + cPerUnit.toFixed(2) + "/" + cParsed.unit;
                                                                    else if (cheap.price) cheapLabel += " $" + cheap.price.toFixed(2);
                                                                    if (cheap.pack) cheapLabel += " (" + cheap.pack + ")";
                                                                }
                                                                return (
                                                                <div key={item.id} className="px-4 py-2">
                                                                    <div className="flex items-center justify-between">
                                                                        <div className="flex-1 min-w-0">
                                                                            <span className="text-sm text-gray-800">{language === "es" && item.nameEs ? item.nameEs : item.name}</span>
                                                                            {item.pack && <span className="text-xs text-blue-400 ml-1">{item.pack}</span>}
                                                                            <span className="text-xs text-gray-400 ml-1">({item.categoryName})</span>
                                                                        </div>
                                                                        <span className="font-bold text-mint-700 text-lg ml-3">{item.count}</span>
                                                                    </div>
                                                                    {cheapLabel && <div style={{fontSize: "10px", color: "#856404", background: "#fff3cd", padding: "2px 6px", borderRadius: "4px", marginTop: "2px"}}>{"\u{1F4B0}"} {language === "es" ? "Mas barato" : "Cheaper"}: {cheapLabel}</div>}
                                                                </div>
                                                                );
                                                            })}
                                                        </div>
                                                    </div>
                                                ))}
                                                {vendors.length === 0 && (
                                                    <div className="p-8 text-center text-gray-400">{language === "es" ? "El carrito está vacío" : "Cart is empty"}</div>
                                                )}
                                            </div>
                                            {/* Footer buttons */}
                                            <div className="border-t border-gray-200 p-3 flex gap-2 flex-shrink-0 bg-gray-50">
                                                <button onClick={printInventory} className="flex-1 py-3 bg-blue-600 text-white rounded-xl font-bold text-sm hover:bg-blue-700 active:scale-95 transition">
                                                    {"\u{1F5A8}\u{FE0F}"} {language === "es" ? "Imprimir" : "Print"}
                                                </button>
                                                <button onClick={() => setShowCart(false)} className="flex-1 py-3 bg-gray-200 text-gray-700 rounded-xl font-bold text-sm hover:bg-gray-300 active:scale-95 transition">
                                                    {"\u{2715}"} {language === "es" ? "Cerrar" : "Close"}
                                                </button>
                                            </div>
                                        </div>
                                    </div>
                                );
                            })()}

                            {/* ── CATEGORY VIEW ── */}
                            {invViewMode === "category" && customInventory.map((category, catIdx) => {
                                const searchLower = invSearch.toLowerCase().trim();
                                let filteredItems = searchLower
                                    ? category.items.filter(item =>
                                        (item.name || "").toLowerCase().includes(searchLower) ||
                                        (item.nameEs || "").toLowerCase().includes(searchLower) ||
                                        (item.vendor || "").toLowerCase().includes(searchLower)
                                    )
                                    : category.items;
                                if (invShowOnlyCounted) filteredItems = filteredItems.filter(item => (inventory[item.id] || 0) > 0);
                                if ((searchLower || invShowOnlyCounted) && filteredItems.length === 0) return null;
                                const catKey = "cat-" + catIdx;
                                const isCollapsed = collapsedCats[catKey] && !searchLower;
                                const countedInCat = category.items.filter(i => (inventory[i.id] || 0) > 0).length;

                                // Group by subcategory
                                const subcats = [];
                                let currentSub = null;
                                filteredItems.forEach(item => {
                                    const sub = item.subcat || "";
                                    if (sub !== currentSub) {
                                        subcats.push({ name: sub, items: [] });
                                        currentSub = sub;
                                    }
                                    subcats[subcats.length - 1].items.push(item);
                                });

                                return (
                                <div key={category.id} className="bg-white rounded-xl border border-gray-200 overflow-hidden shadow-sm">
                                    {/* Category header — tap to collapse */}
                                    <button onClick={() => toggleCatCollapse(catKey)}
                                        className="w-full p-3 bg-gradient-to-r from-mint-700 to-mint-600 flex justify-between items-center">
                                        <div className="flex items-center gap-2">
                                            <span className="text-white text-sm font-bold">{language === "es" ? category.nameEs : category.name}</span>
                                            <span className="bg-white/20 text-white text-xs px-2 py-0.5 rounded-full">{filteredItems.length}</span>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            {countedInCat > 0 && <span className="bg-white text-mint-700 text-xs font-bold px-2 py-0.5 rounded-full">{countedInCat} {"\u{2713}"}</span>}
                                            <span className="text-white text-xs">{isCollapsed ? "\u{25B6}" : "\u{25BC}"}</span>
                                        </div>
                                    </button>

                                    {!isCollapsed && (
                                        <div className="divide-y divide-gray-100">
                                            {subcats.map((subGroup, subIdx) => (
                                                <div key={subIdx}>
                                                    {/* Subcategory header */}
                                                    {subGroup.name && (
                                                        <div className="px-3 py-1.5 bg-blue-50 border-b border-blue-100">
                                                            <span className="text-xs font-bold text-blue-700 uppercase tracking-wide">{subGroup.name}</span>
                                                        </div>
                                                    )}

                                                    {subGroup.items.map((item) => {
                                                        const itemIdx = category.items.indexOf(item);
                                                        const count = inventory[item.id] || 0;
                                                        const isEditing = invEditMode && invEditingIdx && invEditingIdx.catIdx === catIdx && invEditingIdx.itemIdx === itemIdx;
                                                        return (
                                                            <div key={item.id} className={`px-3 py-2 ${count > 0 ? "bg-green-50/50" : ""} ${isEditing ? "bg-blue-50 border-l-4 border-blue-500" : ""}`}>
                                                                {isEditing ? (
                                                                    <div className="space-y-2">
                                                                        <input type="text" value={invEditName} onChange={(e) => setInvEditName(e.target.value)}
                                                                            placeholder="Item name" className="w-full px-2 py-1.5 border-2 border-gray-300 rounded-lg text-sm focus:border-mint-700 focus:outline-none" />
                                                                        <input type="text" value={invEditNameEs} onChange={(e) => setInvEditNameEs(e.target.value)}
                                                                            placeholder="Nombre en español" className="w-full px-2 py-1.5 border-2 border-gray-300 rounded-lg text-sm focus:border-mint-700 focus:outline-none" />
                                                                        <div className="flex gap-2">
                                                                            <input type="text" value={invEditSupplier} onChange={(e) => setInvEditSupplier(e.target.value)}
                                                                                placeholder={language === "es" ? "Proveedor" : "Vendor"} className="flex-1 px-2 py-1.5 border-2 border-gray-300 rounded-lg text-sm focus:border-mint-700 focus:outline-none" />
                                                                            <input type="text" value={invEditOrderDay} onChange={(e) => setInvEditOrderDay(e.target.value)}
                                                                                placeholder={language === "es" ? "Día" : "Order day"} className="w-24 px-2 py-1.5 border-2 border-gray-300 rounded-lg text-sm focus:border-mint-700 focus:outline-none" />
                                                                        </div>
                                                                        <div className="flex gap-2">
                                                                            <button onClick={() => saveInvEdit(catIdx, itemIdx)} className="flex-1 bg-green-600 text-white py-1.5 rounded-lg text-sm font-bold hover:bg-green-700">{language === "es" ? "Guardar" : "Save"}</button>
                                                                            <button onClick={() => setInvEditingIdx(null)} className="flex-1 bg-gray-400 text-white py-1.5 rounded-lg text-sm font-bold hover:bg-gray-500">{language === "es" ? "Cancelar" : "Cancel"}</button>
                                                                        </div>
                                                                    </div>
                                                                ) : (
                                                                    <div className="flex items-center justify-between">
                                                                        <div className="flex-1 min-w-0 pr-2">
                                                                            <p className={`text-sm font-semibold ${count > 0 ? "text-green-800" : "text-gray-800"} truncate`}>
                                                                                {language === "es" && item.nameEs ? item.nameEs : item.name}
                                                                            </p>
                                                                            <div className="flex items-center gap-2 mt-0.5">
                                                                                {language === "es" && item.nameEs && <span className="text-xs text-gray-400 italic truncate">{item.name}</span>}
                                                                                {language !== "es" && item.nameEs && <span className="text-xs text-gray-400 italic truncate">{item.nameEs}</span>}
                                                                            </div>
                                                                            <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                                                                                {item.vendorOptions && item.vendorOptions.length > 1 ? (
                                                                                    <select
                                                                                        value={item.preferredVendor || item.vendor || ""}
                                                                                        onChange={(e) => changePreferredVendor(catIdx, itemIdx, e.target.value)}
                                                                                        className="text-xs bg-amber-50 border border-amber-300 rounded px-1 py-0.5 text-amber-800 font-medium focus:outline-none focus:border-amber-500 cursor-pointer"
                                                                                        title={language === "es" ? "Proveedor preferido" : "Preferred vendor"}>
                                                                                        {item.vendorOptions.map(vo => (
                                                                                            <option key={vo.vendor} value={vo.vendor}>
                                                                                                {getVendorOptionLabel(vo, item.id)}
                                                                                            </option>
                                                                                        ))}
                                                                                    </select>
                                                                                ) : (
                                                                                    item.vendor && <span className="text-xs text-gray-500">{item.preferredVendor || item.vendor}</span>
                                                                                )}
                                                                                {renderLivePriceBadge(item.id, item)}
                                                                                {item.pack && <span className="text-xs text-gray-400">| {item.pack}</span>}
                                                                                {item.price != null && <span className="text-xs text-gray-400">| ${typeof item.price === 'number' ? item.price.toFixed(2) : item.price}</span>}
                                                                                <button onClick={() => {
                                                                                    setInvEditingIdx({catIdx, itemIdx});
                                                                                    setInvEditName(item.name);
                                                                                    setInvEditNameEs(item.nameEs || "");
                                                                                    setInvEditSupplier(item.vendor || item.supplier || "");
                                                                                    setInvEditOrderDay(item.orderDay || "");
                                                                                }} className="text-xs px-1.5 py-0.5 rounded bg-blue-50 text-blue-600 font-medium hover:bg-blue-100 transition">{"\u{270F}\u{FE0F}"} Edit</button>
                                                                            </div>
                                                                            {invCountMeta[item.id] && count > 0 && (
                                                                                <p className="text-xs text-mint-600 mt-0.5">{"\u{2713}"} {invCountMeta[item.id].by} {"\u{2014}"} {invCountMeta[item.id].at}</p>
                                                                            )}
                                                                        </div>
                                                                        <div className="flex items-center gap-1 flex-shrink-0">
                                                                            <>
                                                                                <button onClick={() => updateInventoryCount(item.id, Math.max(0, count - 1))}
                                                                                    className={`w-9 h-9 rounded-lg font-bold text-lg flex items-center justify-center transition ${count > 0 ? "bg-red-100 text-red-700 hover:bg-red-200" : "bg-gray-100 text-gray-400"}`}>{"\u{2212}"}</button>
                                                                                <span className={`w-10 text-center font-bold text-lg ${count > 0 ? "text-green-700" : "text-gray-300"}`}>{count}</span>
                                                                                <button onClick={() => updateInventoryCount(item.id, count + 1)}
                                                                                    className="w-9 h-9 rounded-lg bg-green-100 text-green-700 font-bold text-lg flex items-center justify-center hover:bg-green-200 active:scale-95 transition">+</button>
                                                                            </>
                                                                        </div>
                                                                    </div>
                                                                )}
                                                            </div>
                                                        );
                                                    })}
                                                </div>
                                            ))}
                                            {/* Write-in */}
                                            {!invEditMode && (
                                                <div className="px-3 py-2 bg-gray-50">
                                                    <div className="flex items-center gap-2">
                                                        <input type="text"
                                                            value={writeInValues[catIdx] || ""}
                                                            onChange={e => setWriteInValues(prev => ({ ...prev, [catIdx]: e.target.value }))}
                                                            onKeyDown={e => { if (e.key === "Enter") quickAddItem(catIdx); }}
                                                            placeholder={language === "es" ? "\u{270D}\u{FE0F} Escribir artículo..." : "\u{270D}\u{FE0F} Write in item..."}
                                                            className="flex-1 px-2 py-1.5 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:border-mint-500" />
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
                                                <div className="p-3 bg-green-50 border-t-2 border-green-500 space-y-2">
                                                    <input type="text" value={invNewName} onChange={(e) => setInvNewName(e.target.value)}
                                                        placeholder={language === "es" ? "Nombre del artículo" : "New item name"} className="w-full px-2 py-1.5 border-2 border-gray-300 rounded-lg text-sm focus:border-mint-700 focus:outline-none" />
                                                    <input type="text" value={invNewNameEs} onChange={(e) => setInvNewNameEs(e.target.value)}
                                                        placeholder={language === "es" ? "Nombre en español" : "Name in Spanish"} className="w-full px-2 py-1.5 border-2 border-gray-300 rounded-lg text-sm focus:border-mint-700 focus:outline-none" />
                                                    <div className="flex gap-2">
                                                        <input type="text" value={invNewSupplier} onChange={(e) => setInvNewSupplier(e.target.value)}
                                                            placeholder={language === "es" ? "Proveedor" : "Vendor"} className="flex-1 px-2 py-1.5 border-2 border-gray-300 rounded-lg text-sm focus:border-mint-700 focus:outline-none" />
                                                        <input type="text" value={invNewOrderDay} onChange={(e) => setInvNewOrderDay(e.target.value)}
                                                            placeholder={language === "es" ? "Día" : "Order day"} className="w-24 px-2 py-1.5 border-2 border-gray-300 rounded-lg text-sm focus:border-mint-700 focus:outline-none" />
                                                    </div>
                                                    <div className="flex gap-2">
                                                        <button onClick={() => addInvItem(catIdx)} className="flex-1 bg-green-600 text-white py-1.5 rounded-lg text-sm font-bold hover:bg-green-700">{language === "es" ? "Agregar" : "Add"}</button>
                                                        <button onClick={() => setInvShowAddForm(null)} className="flex-1 bg-gray-400 text-white py-1.5 rounded-lg text-sm font-bold hover:bg-gray-500">{language === "es" ? "Cancelar" : "Cancel"}</button>
                                                    </div>
                                                </div>
                                            ) : invEditMode && (
                                                <button onClick={() => setInvShowAddForm(catIdx)} className="w-full py-2 text-green-600 font-bold text-sm bg-green-50 hover:bg-green-100 border-t border-green-200 transition">
                                                    + {language === "es" ? "Agregar Artículo" : "Add Item"}
                                                </button>
                                            )}
                                        </div>
                                    )}
                                </div>
                            ); })}

                            {/* ── VENDOR VIEW ── */}
                            {invViewMode === "vendor" && (() => {
                                const vendorGroups = {};
                                customInventory.forEach((cat, catIdx) => {
                                    cat.items.forEach(item => {
                                        const v = item.vendor || item.supplier || "Other";
                                        if (!vendorGroups[v]) vendorGroups[v] = [];
                                        const searchLower = invSearch.toLowerCase().trim();
                                        const matchesSearch = !searchLower ||
                                            (item.name || "").toLowerCase().includes(searchLower) ||
                                            (item.nameEs || "").toLowerCase().includes(searchLower) ||
                                            v.toLowerCase().includes(searchLower);
                                        const matchesCounted = !invShowOnlyCounted || (inventory[item.id] || 0) > 0;
                                        if (matchesSearch && matchesCounted) {
                                            vendorGroups[v].push({ ...item, catIdx, itemIdx: cat.items.indexOf(item), catName: cat.name, catNameEs: cat.nameEs });
                                        }
                                    });
                                });
                                const vendorNames = Object.keys(vendorGroups).filter(v => vendorGroups[v].length > 0).sort((a, b) => vendorGroups[b].length - vendorGroups[a].length);
                                return vendorNames.map(vendor => {
                                    const vItems = vendorGroups[vendor].sort((a, b) => a.name.localeCompare(b.name));
                                    const vKey = "ven-" + vendor;
                                    const isCollapsed = collapsedCats[vKey] && !invSearch;
                                    const countedInV = vItems.filter(i => (inventory[i.id] || 0) > 0).length;
                                    return (
                                        <div key={vendor} className="bg-white rounded-xl border border-gray-200 overflow-hidden shadow-sm">
                                            <button onClick={() => toggleCatCollapse(vKey)}
                                                className="w-full p-3 bg-gradient-to-r from-blue-700 to-blue-600 flex justify-between items-center">
                                                <div className="flex items-center gap-2">
                                                    <span className="text-white text-sm font-bold">{vendor}</span>
                                                    <span className="bg-white/20 text-white text-xs px-2 py-0.5 rounded-full">{vItems.length}</span>
                                                </div>
                                                <div className="flex items-center gap-2">
                                                    {countedInV > 0 && <span className="bg-white text-blue-700 text-xs font-bold px-2 py-0.5 rounded-full">{countedInV} {"\u{2713}"}</span>}
                                                    <span className="text-white text-xs">{isCollapsed ? "\u{25B6}" : "\u{25BC}"}</span>
                                                </div>
                                            </button>
                                            {!isCollapsed && (
                                                <div className="divide-y divide-gray-100">
                                                    {vItems.map(item => {
                                                        const count = inventory[item.id] || 0;
                                                        const isEditing = invEditingIdx && invEditingIdx.catIdx === item.catIdx && invEditingIdx.itemIdx === item.itemIdx;
                                                        return (
                                                            <div key={item.id} className={`px-3 py-2 ${count > 0 ? "bg-green-50/50" : ""} ${isEditing ? "bg-blue-50 border-l-4 border-blue-500" : ""}`}>
                                                                {isEditing ? (
                                                                    <div className="space-y-2">
                                                                        <input type="text" value={invEditName} onChange={(e) => setInvEditName(e.target.value)}
                                                                            placeholder="Item name" className="w-full px-2 py-1.5 border-2 border-gray-300 rounded-lg text-sm focus:border-mint-700 focus:outline-none" />
                                                                        <input type="text" value={invEditNameEs} onChange={(e) => setInvEditNameEs(e.target.value)}
                                                                            placeholder="Nombre en español" className="w-full px-2 py-1.5 border-2 border-gray-300 rounded-lg text-sm focus:border-mint-700 focus:outline-none" />
                                                                        <div className="flex gap-2">
                                                                            <input type="text" value={invEditSupplier} onChange={(e) => setInvEditSupplier(e.target.value)}
                                                                                placeholder={language === "es" ? "Proveedor" : "Vendor"} className="flex-1 px-2 py-1.5 border-2 border-gray-300 rounded-lg text-sm focus:border-mint-700 focus:outline-none" />
                                                                            <input type="text" value={invEditOrderDay} onChange={(e) => setInvEditOrderDay(e.target.value)}
                                                                                placeholder={language === "es" ? "Día" : "Order day"} className="w-24 px-2 py-1.5 border-2 border-gray-300 rounded-lg text-sm focus:border-mint-700 focus:outline-none" />
                                                                        </div>
                                                                        <div className="flex gap-2">
                                                                            <button onClick={() => saveInvEdit(item.catIdx, item.itemIdx)} className="flex-1 bg-green-600 text-white py-1.5 rounded-lg text-sm font-bold hover:bg-green-700">{language === "es" ? "Guardar" : "Save"}</button>
                                                                            <button onClick={() => setInvEditingIdx(null)} className="flex-1 bg-gray-400 text-white py-1.5 rounded-lg text-sm font-bold hover:bg-gray-500">{language === "es" ? "Cancelar" : "Cancel"}</button>
                                                                        </div>
                                                                    </div>
                                                                ) : (
                                                                <div className="flex items-center justify-between">
                                                                    <div className="flex-1 min-w-0 pr-2">
                                                                        <p className={`text-sm font-semibold ${count > 0 ? "text-green-800" : "text-gray-800"} truncate`}>
                                                                            {language === "es" && item.nameEs ? item.nameEs : item.name}
                                                                        </p>
                                                                        <div className="flex items-center gap-2 mt-0.5">
                                                                            {language === "es" && item.nameEs && <span className="text-xs text-gray-400 italic truncate">{item.name}</span>}
                                                                            {language !== "es" && item.nameEs && <span className="text-xs text-gray-400 italic truncate">{item.nameEs}</span>}
                                                                        </div>
                                                                        <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                                                                            <span className="text-xs text-blue-600 font-medium">{language === "es" ? item.catNameEs : item.catName}</span>
                                                                            {item.vendorOptions && item.vendorOptions.length > 1 ? (
                                                                                <select
                                                                                    value={item.preferredVendor || item.vendor || ""}
                                                                                    onChange={(e) => changePreferredVendor(item.catIdx, item.itemIdx, e.target.value)}
                                                                                    className="text-xs bg-amber-50 border border-amber-300 rounded px-1 py-0.5 text-amber-800 font-medium focus:outline-none focus:border-amber-500 cursor-pointer"
                                                                                    title={language === "es" ? "Proveedor preferido" : "Preferred vendor"}>
                                                                                    {item.vendorOptions.map(vo => (
                                                                                        <option key={vo.vendor} value={vo.vendor}>
                                                                                            {getVendorOptionLabel(vo, item.id)}
                                                                                        </option>
                                                                                    ))}
                                                                                </select>
                                                                            ) : (
                                                                                (item.preferredVendor || item.vendor) && <span className="text-xs text-gray-500">{item.preferredVendor || item.vendor}</span>
                                                                            )}
                                                                            {renderLivePriceBadge(item.id, item)}
                                                                            {item.pack && <span className="text-xs text-gray-400">| {item.pack}</span>}
                                                                            {item.price != null && <span className="text-xs text-gray-400">| ${typeof item.price === 'number' ? item.price.toFixed(2) : item.price}</span>}
                                                                            <button onClick={() => {
                                                                                setInvEditingIdx({catIdx: item.catIdx, itemIdx: item.itemIdx});
                                                                                setInvEditName(item.name);
                                                                                setInvEditNameEs(item.nameEs || "");
                                                                                setInvEditSupplier(item.vendor || item.supplier || "");
                                                                                setInvEditOrderDay(item.orderDay || "");
                                                                            }} className="text-xs px-1.5 py-0.5 rounded bg-blue-50 text-blue-600 font-medium hover:bg-blue-100 transition">{"\u{270F}\u{FE0F}"} Edit</button>
                                                                        </div>
                                                                    </div>
                                                                    <div className="flex items-center gap-1 flex-shrink-0">
                                                                        <button onClick={() => updateInventoryCount(item.id, Math.max(0, count - 1))}
                                                                            className={`w-9 h-9 rounded-lg font-bold text-lg flex items-center justify-center transition ${count > 0 ? "bg-red-100 text-red-700 hover:bg-red-200" : "bg-gray-100 text-gray-400"}`}>{"\u{2212}"}</button>
                                                                        <span className={`w-10 text-center font-bold text-lg ${count > 0 ? "text-green-700" : "text-gray-300"}`}>{count}</span>
                                                                        <button onClick={() => updateInventoryCount(item.id, count + 1)}
                                                                            className="w-9 h-9 rounded-lg bg-green-100 text-green-700 font-bold text-lg flex items-center justify-center hover:bg-green-200 active:scale-95 transition">+</button>
                                                                    </div>
                                                                </div>
                                                                )}
                                                            </div>
                                                        );
                                                    })}
                                                </div>
                                            )}
                                        </div>
                                    );
                                });
                            })()}

                            {/* ── SPLIT VIEW ── */}
                            {invViewMode === "split" && (() => {
                                const SPLIT_LISTS = [
                                    { name: "Lorena", nameEs: "Lorena", emoji: "\u{2744}\u{FE0F}", color: "from-cyan-700 to-cyan-600", label: language === "es" ? "Congelador y Refrigerador" : "Freezer & Cooler", categories: ["Proteins", "Produce", "Dairy & Eggs", "Frozen"] },
                                    { name: "Yuly", nameEs: "Yuly", emoji: "\u{1F4E6}", color: "from-amber-600 to-amber-500", label: language === "es" ? "Seco, Papel y Salsas" : "Dry, Paper & Sauces", categories: ["Sauces & Seasonings", "Rice & Noodles", "Oils & Cooking", "Paper & Supplies", "Cleaning"] },
                                    { name: "Brandon", nameEs: "Brandon", emoji: "\u{1F964}", color: "from-green-700 to-green-600", label: language === "es" ? "Bebidas" : "Beverages", categories: ["Beverages"] }
                                ];
                                const searchLower = invSearch.toLowerCase().trim();

                                // Build item assignments: default by category, then apply overrides
                                const getPersonForItem = (item, defaultPerson) => {
                                    if (splitOverrides[item.id]) return splitOverrides[item.id];
                                    return defaultPerson;
                                };

                                // Collect all items per person (including moved items from other people)
                                const personItems = {};
                                SPLIT_LISTS.forEach(p => { personItems[p.name] = []; });

                                customInventory.forEach((cat, cIdx) => {
                                    // Find the default person for this category
                                    const defaultPerson = SPLIT_LISTS.find(p => p.categories.includes(cat.name));
                                    if (!defaultPerson) return;
                                    cat.items.forEach((item, iIdx) => {
                                        const assignedTo = getPersonForItem(item, defaultPerson.name);
                                        if (personItems[assignedTo]) {
                                            personItems[assignedTo].push({ ...item, catName: cat.name, catNameEs: cat.nameEs, catIdx: cIdx, itemIdx: iIdx });
                                        } else {
                                            // If override points to non-existent person, keep with default
                                            personItems[defaultPerson.name].push({ ...item, catName: cat.name, catNameEs: cat.nameEs, catIdx: cIdx, itemIdx: iIdx });
                                        }
                                    });
                                });

                                return SPLIT_LISTS.map((person, pIdx) => {
                                    const allItems = personItems[person.name] || [];
                                    // Group items by category for display
                                    const catGroups = {};
                                    allItems.forEach(item => {
                                        const key = item.catName;
                                        if (!catGroups[key]) catGroups[key] = { name: item.catName, nameEs: item.catNameEs, items: [] };
                                        catGroups[key].items.push(item);
                                    });
                                    const catList = Object.values(catGroups);

                                    let totalCounted = 0;
                                    let totalItems = allItems.length;
                                    allItems.forEach(item => { if ((inventory[item.id] || 0) > 0) totalCounted++; });

                                    // Include write-ins in total
                                    const writeIns = splitWriteIns[person.name] || [];
                                    totalItems += writeIns.length;
                                    writeIns.forEach(wi => { if (wi.count > 0) totalCounted++; });

                                    const pKey = "split-" + pIdx;
                                    const isCollapsed = collapsedCats[pKey] && !searchLower;
                                    return (
                                        <div key={pIdx} className="bg-white rounded-xl border-2 border-gray-200 overflow-hidden shadow-sm">
                                            <button onClick={() => toggleCatCollapse(pKey)}
                                                className={`w-full p-3 bg-gradient-to-r ${person.color} flex justify-between items-center`}>
                                                <div className="flex items-center gap-2">
                                                    <span className="text-lg">{person.emoji}</span>
                                                    <div className="text-left">
                                                        <span className="text-white font-bold text-base">{person.name}</span>
                                                        <span className="text-white/70 text-xs ml-2">{person.label}</span>
                                                    </div>
                                                </div>
                                                <div className="flex items-center gap-2">
                                                    {totalCounted > 0 && <span className="bg-white text-gray-700 text-xs font-bold px-2 py-0.5 rounded-full">{totalCounted}/{totalItems}</span>}
                                                    <span className="text-white text-xs">{isCollapsed ? "\u{25B6}" : "\u{25BC}"}</span>
                                                </div>
                                            </button>
                                            {!isCollapsed && (<>
                                                {catList.map((category, catIdx) => {
                                                    let filteredItems = searchLower
                                                        ? category.items.filter(item =>
                                                            (item.name || "").toLowerCase().includes(searchLower) ||
                                                            (item.nameEs || "").toLowerCase().includes(searchLower) ||
                                                            (item.vendor || "").toLowerCase().includes(searchLower))
                                                        : category.items;
                                                    if (invShowOnlyCounted) filteredItems = filteredItems.filter(item => (inventory[item.id] || 0) > 0);
                                                    if (filteredItems.length === 0) return null;
                                                    const countedInCat = category.items.filter(i => (inventory[i.id] || 0) > 0).length;
                                                    return (
                                                        <div key={catIdx}>
                                                            <div className="px-3 py-1.5 bg-gray-50 border-y border-gray-100 flex justify-between items-center">
                                                                <span className="text-xs font-bold text-gray-500 uppercase">{language === "es" ? category.nameEs : category.name}</span>
                                                                {countedInCat > 0 && <span className="text-xs text-mint-700 font-bold">{countedInCat} {"\u{2713}"}</span>}
                                                            </div>
                                                            <div className="divide-y divide-gray-100">
                                                                {filteredItems.map((item) => {
                                                                    const count = inventory[item.id] || 0;
                                                                    const isMoving = splitMovingItem && splitMovingItem.itemId === item.id;
                                                                    const wasMoved = !!splitOverrides[item.id];
                                                                    const isEditing = invEditingIdx && invEditingIdx.catIdx === item.catIdx && invEditingIdx.itemIdx === item.itemIdx;
                                                                    return (
                                                                        <div key={item.id} className={`px-3 py-2 ${count > 0 ? "bg-green-50/50" : ""} ${isEditing ? "bg-blue-50 border-l-4 border-blue-500" : ""}`}>
                                                                            {isEditing ? (
                                                                                <div className="space-y-2">
                                                                                    <input type="text" value={invEditName} onChange={(e) => setInvEditName(e.target.value)}
                                                                                        placeholder="Item name" className="w-full px-2 py-1.5 border-2 border-gray-300 rounded-lg text-sm focus:border-mint-700 focus:outline-none" />
                                                                                    <input type="text" value={invEditNameEs} onChange={(e) => setInvEditNameEs(e.target.value)}
                                                                                        placeholder="Nombre en español" className="w-full px-2 py-1.5 border-2 border-gray-300 rounded-lg text-sm focus:border-mint-700 focus:outline-none" />
                                                                                    <div className="flex gap-2">
                                                                                        <input type="text" value={invEditSupplier} onChange={(e) => setInvEditSupplier(e.target.value)}
                                                                                            placeholder={language === "es" ? "Proveedor" : "Vendor"} className="flex-1 px-2 py-1.5 border-2 border-gray-300 rounded-lg text-sm focus:border-mint-700 focus:outline-none" />
                                                                                        <input type="text" value={invEditOrderDay} onChange={(e) => setInvEditOrderDay(e.target.value)}
                                                                                            placeholder={language === "es" ? "Día" : "Order day"} className="w-24 px-2 py-1.5 border-2 border-gray-300 rounded-lg text-sm focus:border-mint-700 focus:outline-none" />
                                                                                    </div>
                                                                                    <div className="flex gap-2">
                                                                                        <button onClick={() => saveInvEdit(item.catIdx, item.itemIdx)} className="flex-1 bg-green-600 text-white py-1.5 rounded-lg text-sm font-bold hover:bg-green-700">{language === "es" ? "Guardar" : "Save"}</button>
                                                                                        <button onClick={() => setInvEditingIdx(null)} className="flex-1 bg-gray-400 text-white py-1.5 rounded-lg text-sm font-bold hover:bg-gray-500">{language === "es" ? "Cancelar" : "Cancel"}</button>
                                                                                    </div>
                                                                                </div>
                                                                            ) : (
                                                                            <div className="flex items-center justify-between">
                                                                                <div className="flex-1 min-w-0 pr-2">
                                                                                    <div className="flex items-center gap-1">
                                                                                        <p className={`text-sm font-semibold ${count > 0 ? "text-green-800" : "text-gray-800"} truncate`}>
                                                                                            {language === "es" && item.nameEs ? item.nameEs : item.name}
                                                                                        </p>
                                                                                        {wasMoved && <span className="text-xs bg-purple-100 text-purple-600 px-1 rounded">{"\u{21C4}"}</span>}
                                                                                    </div>
                                                                                    <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                                                                                        {item.vendorOptions && item.vendorOptions.length > 1 ? (
                                                                                            <select
                                                                                                value={item.preferredVendor || item.vendor || ""}
                                                                                                onChange={(e) => changePreferredVendor(item.catIdx, item.itemIdx, e.target.value)}
                                                                                                className="text-xs bg-amber-50 border border-amber-300 rounded px-1 py-0.5 text-amber-800 font-medium focus:outline-none focus:border-amber-500 cursor-pointer"
                                                                                                title={language === "es" ? "Proveedor preferido" : "Preferred vendor"}>
                                                                                                {item.vendorOptions.map(vo => (
                                                                                                    <option key={vo.vendor} value={vo.vendor}>
                                                                                                        {getVendorOptionLabel(vo, item.id)}
                                                                                                    </option>
                                                                                                ))}
                                                                                            </select>
                                                                                        ) : (
                                                                                            (item.preferredVendor || item.vendor) && <span className="text-xs text-blue-600 font-medium">{item.preferredVendor || item.vendor}</span>
                                                                                        )}
                                                                                        {renderLivePriceBadge(item.id, item)}
                                                                                        {item.pack && <span className="text-xs text-gray-400">| {item.pack}</span>}
                                                                                        {item.price != null && <span className="text-xs text-gray-400">| ${typeof item.price === 'number' ? item.price.toFixed(2) : item.price}</span>}
                                                                                        <button onClick={() => setSplitMovingItem(isMoving ? null : { itemId: item.id, fromPerson: person.name })}
                                                                                            className={`text-xs px-1.5 py-0.5 rounded font-medium transition ${isMoving ? "bg-purple-600 text-white" : "bg-gray-100 text-gray-500 hover:bg-gray-200"}`}>
                                                                                            {isMoving ? "\u{2715}" : "\u{21C4}"} {language === "es" ? "Mover" : "Move"}
                                                                                        </button>
                                                                                        <button onClick={() => {
                                                                                            setInvEditingIdx({catIdx: item.catIdx, itemIdx: item.itemIdx});
                                                                                            setInvEditName(item.name);
                                                                                            setInvEditNameEs(item.nameEs || "");
                                                                                            setInvEditSupplier(item.vendor || item.supplier || "");
                                                                                            setInvEditOrderDay(item.orderDay || "");
                                                                                        }} className="text-xs px-1.5 py-0.5 rounded bg-blue-50 text-blue-600 font-medium hover:bg-blue-100 transition">{"\u{270F}\u{FE0F}"} Edit</button>
                                                                                    </div>
                                                                                    {isMoving && (
                                                                                        <div className="flex gap-1 mt-1">
                                                                                            {SPLIT_LISTS.filter(p => p.name !== person.name).map(p => (
                                                                                                <button key={p.name} onClick={() => moveSplitItem(item.id, p.name)}
                                                                                                    className="text-xs px-2 py-1 bg-purple-100 text-purple-700 rounded-lg font-bold hover:bg-purple-200 active:scale-95 transition">
                                                                                                    {p.emoji} {p.name}
                                                                                                </button>
                                                                                            ))}
                                                                                            {wasMoved && (
                                                                                                <button onClick={() => { const updated = { ...splitOverrides }; delete updated[item.id]; setSplitOverrides(updated); saveSplitConfig(updated, splitWriteIns); setSplitMovingItem(null); }}
                                                                                                    className="text-xs px-2 py-1 bg-gray-100 text-gray-600 rounded-lg font-bold hover:bg-gray-200 active:scale-95 transition">
                                                                                                    {"\u{21A9}"} {language === "es" ? "Original" : "Reset"}
                                                                                                </button>
                                                                                            )}
                                                                                        </div>
                                                                                    )}
                                                                                </div>
                                                                                <div className="flex items-center gap-1 flex-shrink-0">
                                                                                    <button onClick={() => updateInventoryCount(item.id, Math.max(0, count - 1))}
                                                                                        className={`w-9 h-9 rounded-lg font-bold text-lg flex items-center justify-center transition ${count > 0 ? "bg-red-100 text-red-700 hover:bg-red-200" : "bg-gray-100 text-gray-400"}`}>{"\u{2212}"}</button>
                                                                                    <span className={`w-10 text-center font-bold text-lg ${count > 0 ? "text-green-700" : "text-gray-300"}`}>{count}</span>
                                                                                    <button onClick={() => updateInventoryCount(item.id, count + 1)}
                                                                                        className="w-9 h-9 rounded-lg bg-green-100 text-green-700 font-bold text-lg flex items-center justify-center hover:bg-green-200 active:scale-95 transition">+</button>
                                                                                </div>
                                                                            </div>
                                                                            )}
                                                                        </div>
                                                                    );
                                                                })}
                                                            </div>
                                                        </div>
                                                    );
                                                })}
                                                {/* Write-in items for this person */}
                                                {writeIns.length > 0 && (
                                                    <div>
                                                        <div className="px-3 py-1.5 bg-yellow-50 border-y border-yellow-200 flex justify-between items-center">
                                                            <span className="text-xs font-bold text-yellow-700 uppercase">{"\u{270D}\u{FE0F}"} {language === "es" ? "Artículos Escritos" : "Write-In Items"}</span>
                                                        </div>
                                                        <div className="divide-y divide-gray-100">
                                                            {writeIns.map(wi => (
                                                                <div key={wi.id} className={`px-3 py-2 ${wi.count > 0 ? "bg-yellow-50/50" : ""}`}>
                                                                    <div className="flex items-center justify-between">
                                                                        <div className="flex-1 min-w-0 pr-2">
                                                                            <p className={`text-sm font-semibold ${wi.count > 0 ? "text-yellow-800" : "text-gray-800"}`}>{wi.name}</p>
                                                                        </div>
                                                                        <div className="flex items-center gap-1 flex-shrink-0">
                                                                            <button onClick={() => updateSplitWriteInCount(person.name, wi.id, Math.max(0, wi.count - 1))}
                                                                                className={`w-9 h-9 rounded-lg font-bold text-lg flex items-center justify-center transition ${wi.count > 0 ? "bg-red-100 text-red-700 hover:bg-red-200" : "bg-gray-100 text-gray-400"}`}>{"\u{2212}"}</button>
                                                                            <span className={`w-10 text-center font-bold text-lg ${wi.count > 0 ? "text-yellow-700" : "text-gray-300"}`}>{wi.count}</span>
                                                                            <button onClick={() => updateSplitWriteInCount(person.name, wi.id, wi.count + 1)}
                                                                                className="w-9 h-9 rounded-lg bg-green-100 text-green-700 font-bold text-lg flex items-center justify-center hover:bg-green-200 active:scale-95 transition">+</button>
                                                                            <button onClick={() => removeSplitWriteIn(person.name, wi.id)}
                                                                                className="w-7 h-7 rounded-lg bg-red-50 text-red-400 font-bold text-sm flex items-center justify-center hover:bg-red-100 ml-1">{"\u{2715}"}</button>
                                                                        </div>
                                                                    </div>
                                                                </div>
                                                            ))}
                                                        </div>
                                                    </div>
                                                )}
                                                {/* Write-in input */}
                                                <div className="px-3 py-2 bg-gray-50 border-t border-gray-200">
                                                    <div className="flex items-center gap-2">
                                                        <input type="text"
                                                            value={splitWriteInValues[person.name] || ""}
                                                            onChange={e => setSplitWriteInValues(prev => ({ ...prev, [person.name]: e.target.value }))}
                                                            onKeyDown={e => { if (e.key === "Enter") addSplitWriteIn(person.name); }}
                                                            placeholder={language === "es" ? `\u{270D}\u{FE0F} Escribir para ${person.name}...` : `\u{270D}\u{FE0F} Write in for ${person.name}...`}
                                                            className="flex-1 px-2 py-1.5 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:border-mint-500" />
                                                        {(splitWriteInValues[person.name] || "").trim() && (
                                                            <button onClick={() => addSplitWriteIn(person.name)}
                                                                className="px-3 py-1.5 bg-mint-600 text-white rounded-lg text-xs font-bold hover:bg-mint-700 active:scale-95 transition">
                                                                {language === "es" ? "Agregar" : "Add"}
                                                            </button>
                                                        )}
                                                    </div>
                                                </div>
                                            </>)}
                                        </div>
                                    );
                                });
                            })()}

                            {/* ── PRICING VIEW ── */}
                            {invViewMode === "pricing" && (() => {
                                const syscoData = livePrices.sysco || {};
                                const prices = syscoData.prices || {};

                                // Sysco ID → inventory item mapping
                                const SYSCO_INVENTORY_MAP = {
                                    // === Proteins / Seafood ===
                                    "5106402": { invId: "0-26", note: "Shrimp White P&D Tail-off 21/25" },
                                    "7952468": { invId: "0-27", note: "Shrimp White P&D Tail-off 31/40" },
                                    "7411241": { invId: "0-28", note: "Shrimp White P&D Tail-on 21/25" },
                                    "7950306": { invId: "0-25", note: "Shrimp 31/40 Tail-on" },
                                    "2398519": { invId: "0-32", note: "Scallops 60-80 Count" },
                                    // === Produce ===
                                    "7350788": { invId: "1-19", note: "Green Onion" },
                                    "7078475": { invId: "1-12", note: "Cilantro Iceless" },
                                    "1008010": { invId: "1-5", note: "Cabbage Red" },
                                    "1491810": { invId: "1-4", note: "Cabbage Green" },
                                    "1821529": { invId: "1-21", note: "Shallots Fresh" },
                                    // === Frozen ===
                                    "4390807": { invId: "9-9", note: "Sweet Potato Waffle Fry Battered" },
                                    "0937631": { invId: "9-2", note: "Churros" },
                                    // === Rice & Dry ===
                                    "4671434": { invId: "4-12", note: "Rice Long Grain / Jasmine" },
                                    // === Sauces & Condiments ===
                                    "7257721": { invId: "3-54", note: "Sriracha Packets" },
                                    "7011275": { invId: "3-54", note: "Sriracha Packets (Huy Fong)" },
                                    // === Beverages ===
                                    "7101689": { invId: null, note: "Tazo Chai Tea Concentrate (no inv match)" },
                                    // === Paper & Disposable ===
                                    "7385215": { invId: "7-4", note: "Container Togo Kraft #8" },
                                    "6977799": { invId: "7-65", note: "Napkin XpressNap Natural" },
                                    "2102038": { invId: "7-54", note: "Bamboo Picks Knotted 4in" },
                                    "7213296": { invId: null, note: "Bag Poly Deli HD 8.5x8.5 (no inv match)" },
                                    "7701311": { invId: null, note: "Bag Plastic HD 7-Day Pre Portion (no inv match)" },
                                    "4527950": { invId: null, note: "Dispenser Towel Manual (no inv match)" },
                                    // === Day Labels (all map to Label Roll) ===
                                    "9904133": { invId: "7-74", note: "Label Friday" },
                                    "9903882": { invId: "7-74", note: "Label Monday" },
                                    "9904135": { invId: "7-74", note: "Label Saturday" },
                                    "9904127": { invId: "7-74", note: "Label Thursday" },
                                    "9904138": { invId: "7-74", note: "Label Wednesday" },
                                    // === Chemical & Janitorial ===
                                    "0616526": { invId: "8-3", note: "Degreaser" },
                                    "7670021": { invId: "8-4", note: "Delimer Descaler" },
                                    "7260143": { invId: "8-1", note: "Cleaner Floor Alkaline No-rinse" },
                                    "9901417": { invId: "8-2", note: "Cleaner Grill High Temp" },
                                    "5287489": { invId: "8-12", note: "Hand Soap Antibacterial" },
                                    "5256670": { invId: "8-18", note: "Sanitizer Tablets" },
                                    "8265625": { invId: "8-5", note: "Detergent Machine Solid Power" },
                                    "1293212": { invId: null, note: "Cleaner Vigoroso Lavender (no inv match)" },
                                    "6892063": { invId: null, note: "Cleaner Freezer (no inv match)" },
                                    "5061239": { invId: "8-13", note: "Sanitizer Machine Ecotemp" },
                                    "4278760": { invId: "8-8", note: "Rinse Aid SmartPower" },
                                    // === Supplies & Equipment ===
                                    "3438292": { invId: null, note: "Spray Bottle 32oz (no inv match)" },
                                };

                                // Build flat inventory lookup
                                const invLookup = {};
                                customInventory.forEach(cat => cat.items.forEach(item => { invLookup[item.id] = item; }));

                                // Merge: show ALL 39 mapped items, fill in live price data where available
                                const allEntries = Object.keys(SYSCO_INVENTORY_MAP).map(syscoId => {
                                    const liveData = prices[syscoId] || {};
                                    const mapEntry = SYSCO_INVENTORY_MAP[syscoId];
                                    return [syscoId, {
                                        name: liveData.name || mapEntry.note || `Sysco Item ${syscoId}`,
                                        price: liveData.price != null ? liveData.price : null,
                                        pack: liveData.pack || "",
                                        brand: liveData.brand || "",
                                        unit: liveData.unit || "CS",
                                        lastOrdered: liveData.lastOrdered || "",
                                    }];
                                });
                                // Also add any scraped items NOT in the map (future new items)
                                Object.entries(prices).forEach(([k, v]) => {
                                    if (!SYSCO_INVENTORY_MAP[k]) allEntries.push([k, v]);
                                });

                                // Sort: matched (has invId) first, then unmatched, alphabetical within each
                                const sorted = [...allEntries].sort((a, b) => {
                                    const aMap = SYSCO_INVENTORY_MAP[a[0]];
                                    const bMap = SYSCO_INVENTORY_MAP[b[0]];
                                    const aRank = aMap && aMap.invId ? 0 : 1;
                                    const bRank = bMap && bMap.invId ? 0 : 1;
                                    if (aRank !== bRank) return aRank - bRank;
                                    return (a[1].name || "").localeCompare(b[1].name || "");
                                });

                                return (
                                    <div className="space-y-2">
                                        {/* Header */}
                                        <div className="bg-gradient-to-r from-blue-700 to-blue-600 text-white rounded-xl p-3 flex items-center justify-between">
                                            <div>
                                                <div className="font-bold text-sm">{language === "es" ? "Precios de Sysco — Historial de Compras" : "Sysco Pricing — Purchase History"}</div>
                                                <div className="text-blue-200 text-xs mt-0.5">
                                                    {allEntries.length} {language === "es" ? "articulos" : "items"} &middot; {allEntries.filter(([,d]) => d.price != null).length} {language === "es" ? "con precio" : "with prices"}
                                                    {syscoData.lastScraped && (<> &middot; {language === "es" ? "Actualizado" : "Updated"}: {new Date(syscoData.lastScraped).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</>)}
                                                </div>
                                            </div>
                                            <button
                                                onClick={async () => {
                                                    if (syscoTriggerStatus === "requesting" || syscoTriggerStatus === "running") return;
                                                    setSyscoTriggerStatus("requesting");
                                                    try {
                                                        await setDoc(doc(db, "vendor_prices", "sysco_trigger"), {
                                                            trigger: true,
                                                            requestedAt: new Date().toISOString(),
                                                            requestedBy: staffName || "unknown",
                                                            status: "pending"
                                                        });
                                                    } catch (e) {
                                                        console.error("Trigger error:", e);
                                                        setSyscoTriggerStatus("error");
                                                        setTimeout(() => setSyscoTriggerStatus(null), 4000);
                                                    }
                                                }}
                                                disabled={syscoTriggerStatus === "requesting" || syscoTriggerStatus === "running"}
                                                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition ${
                                                    syscoTriggerStatus === "running" || syscoTriggerStatus === "requesting"
                                                        ? "bg-blue-500/30 text-blue-100 cursor-wait"
                                                        : syscoTriggerStatus === "done"
                                                            ? "bg-green-500/30 text-green-100"
                                                            : syscoTriggerStatus === "error"
                                                                ? "bg-red-500/30 text-red-100"
                                                                : "bg-white/20 hover:bg-white/30 text-white cursor-pointer"
                                                }`}
                                                title={language === "es" ? "Solicitar actualizacion de precios" : "Request price refresh"}
                                            >
                                                {syscoTriggerStatus === "running" || syscoTriggerStatus === "requesting" ? (
                                                    <><span className="animate-spin inline-block">{"\u{1F504}"}</span> {language === "es" ? "Actualizando..." : "Refreshing..."}</>
                                                ) : syscoTriggerStatus === "done" ? (
                                                    <>{"\u{2705}"} {language === "es" ? "Listo" : "Done!"}</>
                                                ) : syscoTriggerStatus === "error" ? (
                                                    <>{"\u{274C}"} {language === "es" ? "Error" : "Error"}</>
                                                ) : (
                                                    <>{"\u{1F504}"} {language === "es" ? "Actualizar Precios" : "Refresh Prices"}</>
                                                )}
                                            </button>
                                        </div>

                                        {Object.keys(prices).length === 0 && (
                                            <div className="text-center py-3 text-gray-400 text-xs bg-yellow-50 rounded-lg border border-yellow-200">
                                                {language === "es" ? "Esperando datos del scraper. Los precios se actualizan diariamente." : "Waiting for scraper data. Prices update daily."}
                                            </div>
                                        )}

                                        {/* Matched items section */}
                                        {sorted.filter(([k]) => { const m = SYSCO_INVENTORY_MAP[k]; return m && m.invId; }).length > 0 && (
                                            <div className="text-xs font-bold text-green-700 px-1 pt-1">{"\u{2705}"} {language === "es" ? "Asociado a inventario" : "Matched to Inventory"}</div>
                                        )}

                                        {(() => {
                                            let unmatchedHeaderShown = false;
                                            const hasMatched = sorted.some(([k]) => { const m = SYSCO_INVENTORY_MAP[k]; return m && m.invId; });
                                            return sorted.map(([key, data]) => {
                                            const match = SYSCO_INVENTORY_MAP[key];
                                            const invItem = match && match.invId ? invLookup[match.invId] : null;
                                            const isMatched = !!(match && match.invId);
                                            const showUnmatchedHeader = !isMatched && !unmatchedHeaderShown && hasMatched;
                                            if (showUnmatchedHeader) unmatchedHeaderShown = true;

                                            return (
                                                <div key={key}>
                                                    {showUnmatchedHeader && (
                                                        <div className="text-xs font-bold text-gray-500 px-1 pt-2 pb-1">{"\u{1F4E6}"} {language === "es" ? "Solo en Sysco" : "Sysco Only"}</div>
                                                    )}
                                                    <div className={`rounded-xl p-3 border ${isMatched ? "bg-green-50 border-green-200" : "bg-white border-gray-200"}`}>
                                                        <div className="flex items-start justify-between gap-2">
                                                            <div className="flex-1 min-w-0">
                                                                <div className="font-bold text-sm text-gray-800 truncate">{data.name || `Sysco Item ${key}`}</div>
                                                                {invItem && (
                                                                    <div className="text-xs text-green-600 mt-0.5">{"\u{2194}\u{FE0F}"} {invItem.name}</div>
                                                                )}
                                                                {!invItem && match && match.note && (
                                                                    <div className="text-xs text-gray-400 mt-0.5 italic">{match.note}</div>
                                                                )}
                                                                <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1 text-xs text-gray-500">
                                                                    {data.pack && <span>{language === "es" ? "Paquete" : "Pack"}: {data.pack}</span>}
                                                                    {data.brand && <span>{data.brand}</span>}
                                                                    {key && <span className="text-gray-400">#{key}</span>}
                                                                </div>
                                                                {data.lastOrdered && (
                                                                    <div className="text-xs text-gray-400 mt-0.5">{language === "es" ? "Ultimo pedido" : "Last ordered"}: {data.lastOrdered}</div>
                                                                )}
                                                            </div>
                                                            <div className="text-right flex-shrink-0">
                                                                {data.price != null ? (
                                                                    <>
                                                                        <div className="font-bold text-lg text-blue-700">${data.price.toFixed(2)}</div>
                                                                        <div className="text-xs text-gray-500">/{data.unit || "CS"}</div>
                                                                    </>
                                                                ) : (
                                                                    <div className="text-xs text-gray-300 italic">{language === "es" ? "pendiente" : "pending"}</div>
                                                                )}
                                                            </div>
                                                        </div>
                                                    </div>
                                                </div>
                                            );
                                        });
                                        })()}
                                    </div>
                                );
                            })()}

                            {/* ── SAVE & RESET ── */}
                            {!invEditMode && invViewMode !== "pricing" && (
                                <div className="sticky bottom-20 pt-3">
                                    {showSaveConfirm ? (
                                        <div className="bg-white border-2 border-mint-700 rounded-xl p-4 shadow-xl">
                                            <p className="text-center text-lg font-bold text-gray-800 mb-4">
                                                {language === "es" ? "\u{00BF}Ya REVISASTE?" : "Did you LOOK?"}
                                            </p>
                                            <div className="flex gap-3">
                                                <button onClick={saveAndResetInventory} disabled={inventorySaving}
                                                    className="flex-1 py-3 rounded-xl font-bold text-lg bg-mint-700 text-white hover:bg-mint-800 active:scale-95 transition">
                                                    {inventorySaving ? (language === "es" ? "Guardando..." : "Saving...") : (language === "es" ? "\u{2705} S\u{00ED}" : "\u{2705} Yes")}
                                                </button>
                                                <button onClick={() => setShowSaveConfirm(false)} disabled={inventorySaving}
                                                    className="flex-1 py-3 rounded-xl font-bold text-lg bg-gray-200 text-gray-700 hover:bg-gray-300 transition">
                                                    {language === "es" ? "Cancelar" : "Cancel"}
                                                </button>
                                            </div>
                                        </div>
                                    ) : (
                                        <button onClick={() => setShowSaveConfirm(true)}
                                            className="w-full py-4 rounded-xl font-bold text-lg shadow-lg bg-mint-700 text-white hover:bg-mint-800 active:scale-95 transition">
                                            {language === "es" ? "\u{1F4BE} Guardar y Reiniciar Conteos" : "\u{1F4BE} Save & Reset Counts"}
                                        </button>
                                    )}
                                </div>
                            )}

                            {/* ── VENDOR CHANGE LOG ── */}
                            {vendorChangeLog.length > 0 && (
                                <div className="mt-4">
                                    <button onClick={() => setShowVendorLog(!showVendorLog)}
                                        className="flex items-center gap-2 text-sm font-bold text-amber-700 hover:text-amber-800">
                                        <span>{"\u{1F4DD}"}</span>
                                        <span>{language === "es" ? "Cambios de Proveedor" : "Vendor Changes"} ({vendorChangeLog.length})</span>
                                        <span className="text-xs">{showVendorLog ? "\u{25BC}" : "\u{25B6}"}</span>
                                    </button>
                                    {showVendorLog && (
                                        <div className="mt-2 bg-amber-50 border border-amber-200 rounded-xl overflow-hidden">
                                            {vendorChangeLog.slice(0, 20).map((entry, i) => (
                                                <div key={i} className="px-3 py-2 border-b border-amber-100 last:border-0">
                                                    <p className="text-xs font-semibold text-gray-800">{entry.itemName}</p>
                                                    <p className="text-xs text-gray-600">
                                                        <span className="text-red-500 line-through">{entry.from}</span>
                                                        <span className="mx-1">{"\u{2192}"}</span>
                                                        <span className="text-green-700 font-bold">{entry.to}</span>
                                                    </p>
                                                    <p className="text-xs text-gray-400">{entry.changedBy} {"\u{2014}"} {entry.dateStr}</p>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* ── SAVED LISTS ── */}
                            <div className="mt-6 pt-4 border-t-2 border-gray-200">
                                <h3 className="text-lg font-bold text-mint-700 mb-1">{"\u{1F4E6}"} {language === "es" ? "Listas Guardadas" : "Saved Lists"}</h3>
                                <p className="text-xs text-gray-500 mb-3">{language === "es"
                                    ? "Revisa conteos anteriores, marca lo que ya se pidió."
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
                                }} className="w-9 h-9 rounded-lg bg-gray-200 text-gray-600 font-bold text-lg flex items-center justify-center hover:bg-gray-300">{"\u{2190}"}</button>
                                <div className="flex-1 text-center">
                                    <input type="date" value={breakDate} onChange={e => setBreakDate(e.target.value)}
                                        className="bg-transparent text-center font-bold text-gray-800 border-none text-sm focus:outline-none" />
                                    <div className="text-xs text-gray-500">
                                        {(() => {
                                            const d = new Date(breakDate + "T12:00:00");
                                            const today = getTodayKey();
                                            const tomorrow = (() => { const t = new Date(); t.setDate(t.getDate()+1); return t.getFullYear()+"-"+String(t.getMonth()+1).padStart(2,"0")+"-"+String(t.getDate()).padStart(2,"0"); })();
                                            if (breakDate === today) return language === "es" ? "\u{1F4C5} Hoy" : "\u{1F4C5} Today";
                                            if (breakDate === tomorrow) return language === "es" ? "\u{1F4C5} Mañana" : "\u{1F4C5} Tomorrow";
                                            return d.toLocaleDateString(language === "es" ? "es-US" : "en-US", { weekday: "long" });
                                        })()}
                                    </div>
                                </div>
                                <button onClick={() => {
                                    const d = new Date(breakDate + "T12:00:00");
                                    d.setDate(d.getDate() + 1);
                                    setBreakDate(d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0") + "-" + String(d.getDate()).padStart(2,"0"));
                                }} className="w-9 h-9 rounded-lg bg-gray-200 text-gray-600 font-bold text-lg flex items-center justify-center hover:bg-gray-300">{"\u{2192}"}</button>
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
                                    {language === "es" ? "\u{2713} Guardado" : "\u{2713} Saved"}
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
                                    {"\u{1F4CB}"} {language === "es" ? "Copiar plan de hoy" : "Copy today's plan"}
                                </button>
                            )}

                            {/* {"\u{2500}"}{"\u{2500}"} SKILLS MATRIX {"\u{2500}"}{"\u{2500}"} */}
                            {showMatrix && (
                                <div className="bg-white border-2 border-purple-200 rounded-xl overflow-hidden">
                                    <div className="bg-purple-600 text-white px-4 py-2.5">
                                        <h3 className="font-bold text-sm">{language === "es" ? "\u{1F9E0} Matriz de Habilidades" : "\u{1F9E0} Skills Matrix"}</h3>
                                        <p className="text-xs text-purple-200">{language === "es" ? "Marca qué estaciones puede trabajar cada persona" : "Check which stations each person can work"}</p>
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
                                                                        {checked ? "\u{2713}" : ""}
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

                            {/* {"\u{2500}"}{"\u{2500}"} STATION BOARD {"\u{2500}"}{"\u{2500}"} */}
                            <div className="bg-charcoal rounded-xl p-4">
                                <div className="flex items-center justify-between mb-3">
                                    <h3 className="text-white font-bold text-sm uppercase tracking-wider">
                                        {language === "es" ? "\u{1F4CB} Estaciones de Hoy" : "\u{1F4CB} Today's Stations"}
                                    </h3>
                                    {currentIsAdmin && (
                                        <button onClick={() => setEditingStations(!editingStations)}
                                            className={`text-xs px-2.5 py-1 rounded-full font-bold ${editingStations ? "bg-red-500 text-white" : "bg-white bg-opacity-20 text-white"}`}>
                                            {editingStations ? (language === "es" ? "\u{2715} Cerrar" : "\u{2715} Done") : (language === "es" ? "\u{270F}\u{FE0F} Editar" : "\u{270F}\u{FE0F} Edit")}
                                        </button>
                                    )}
                                </div>

                                {/* {"\u{2500}"}{"\u{2500}"} EDIT MODE {"\u{2500}"}{"\u{2500}"} */}
                                {editingStations && currentIsAdmin && (
                                    <div className="mb-3 space-y-2">
                                        {customStations.map((pos, idx) => (
                                            <div key={pos.id} className="bg-white bg-opacity-10 rounded-lg p-2 flex items-center gap-2">
                                                <div className="flex flex-col gap-0.5">
                                                    <button onClick={() => moveStation(pos.id, -1)} disabled={idx === 0}
                                                        className={`text-xs leading-none ${idx === 0 ? "text-gray-600" : "text-gray-300 hover:text-white"}`}>{"\u{25B2}"}</button>
                                                    <button onClick={() => moveStation(pos.id, 1)} disabled={idx === customStations.length - 1}
                                                        className={`text-xs leading-none ${idx === customStations.length - 1 ? "text-gray-600" : "text-gray-300 hover:text-white"}`}>{"\u{25BC}"}</button>
                                                </div>
                                                <input type="text" value={pos.emoji} onChange={e => updateStationEmoji(pos.id, e.target.value)}
                                                    className="w-10 text-center text-lg bg-white bg-opacity-10 rounded border border-gray-600 text-white" style={{padding: "2px"}} />
                                                <input type="text" value={pos.nameEn} onChange={e => renameStation(pos.id, e.target.value)}
                                                    className="flex-1 bg-white bg-opacity-10 rounded border border-gray-600 text-white text-xs px-2 py-1.5 font-bold" />
                                                <button onClick={() => removeStation(pos.id)}
                                                    className="text-red-400 hover:text-red-300 text-sm font-bold px-1">{"\u{2715}"}</button>
                                            </div>
                                        ))}
                                        {/* Add new station */}
                                        <div className="bg-white bg-opacity-5 rounded-lg p-2 flex items-center gap-2 border border-dashed border-gray-600">
                                            <input type="text" value={newStationEmoji} onChange={e => setNewStationEmoji(e.target.value)}
                                                className="w-10 text-center text-lg bg-white bg-opacity-10 rounded border border-gray-600 text-white" style={{padding: "2px"}}
                                                placeholder="\u{1F4CD}" />
                                            <input type="text" value={newStationName} onChange={e => setNewStationName(e.target.value)}
                                                className="flex-1 bg-white bg-opacity-10 rounded border border-gray-600 text-white text-xs px-2 py-1.5"
                                                placeholder={language === "es" ? "Nueva estación..." : "New station name..."}
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

                                {/* {"\u{2500}"}{"\u{2500}"} ASSIGNMENT GRID {"\u{2500}"}{"\u{2500}"} */}
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
                                                    <option value="">{"\u{2014}"}</option>
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

                            {/* {"\u{2500}"}{"\u{2500}"} BREAK WAVES {"\u{2500}"}{"\u{2500}"} */}
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
                                                <h3 className="font-bold text-sm">{language === "es" ? `Grupo ${waveIdx+1}` : `Wave ${waveIdx+1}`} {"\u{2014}"}</h3>
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
                                                    {/* {"\u{2500}"} Who's going on break? \u{2500} */}
                                                    <p className="text-xs font-bold text-gray-500 uppercase tracking-wide mb-2">
                                                        {language === "es" ? "¿Quién sale a break?" : "Who's going on break?"}
                                                    </p>
                                                    <div className="flex flex-wrap gap-1.5 mb-3">
                                                        {assignedStaff.map(name => {
                                                            const onBreak = breakers.includes(name);
                                                            const alreadyWent = alreadyBroke.has(name);
                                                            const positions = (staffMap[name] || []).map(p => p.emoji).join("");
                                                            if (alreadyWent && !onBreak) {
                                                                // Already took break in earlier wave {"\u{2014}"} show grayed out
                                                                return (
                                                                    <span key={name}
                                                                        className="px-2.5 py-1.5 rounded-full text-xs font-bold border-2 bg-gray-100 text-gray-300 border-gray-100 line-through"
                                                                        title={language === "es" ? "Ya tomó break" : "Already took break"}
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

                                                    {/* {"\u{2500}"} Coverage map {"\u{2500}"} */}
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
                                                                                <option value="">{language === "es" ? "\u{26A0}\u{FE0F} Seleccionar cobertura..." : "\u{26A0}\u{FE0F} Select cover..."}</option>
                                                                                {(() => {
                                                                                    const qualified = getQualifiedCovers(nc.pos.id, available, wave.id);
                                                                                    const unqualified = available.filter(n => !qualified.includes(n));
                                                                                    return [
                                                                                        ...qualified.map(n => (
                                                                                            <option key={n} value={n}>{"\u{2713}"} {n} {(staffMap[n] || []).map(p => p.emoji).join("")}</option>
                                                                                        )),
                                                                                        unqualified.length > 0 && qualified.length > 0 ? <option key="_sep" disabled>{"\u{2500}"}{"\u{2500}"}{"\u{2500}"}{"\u{2500}"}{"\u{2500}"}{"\u{2500}"}{"\u{2500}"}</option> : null,
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

                                                    {/* {"\u{2500}"} Still working (not on break) {"\u{2500}"} */}
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

                                                    {/* {"\u{2500}"} Warnings {"\u{2500}"} */}
                                                    {(uncovered.length > 0 || doubles.length > 0) && (
                                                        <div className="mt-2 space-y-1">
                                                            {uncovered.length > 0 && (
                                                                <div className="text-xs text-red-600 font-bold bg-red-50 rounded px-2 py-1">
                                                                    {"\u{26A0}"}{"\u{FE0F}"} {language === "es" ? "Sin cubrir" : "Uncovered"}: {uncovered.map(nc => (language === "es" ? nc.pos.nameEs : nc.pos.nameEn)).join(", ")}
                                                                </div>
                                                            )}
                                                            {doubles.map(([name, stations]) => (
                                                                <div key={name} className="text-xs text-orange-700 bg-orange-50 rounded px-2 py-1">
                                                                    {"\u{26A0}"}{"\u{FE0F}"} <span className="font-bold">{name.split(" ")[0]}</span> {language === "es" ? "cubre" : "covers"} {stations.join(" + ")}
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
                            {/* {"\u{2500}"}{"\u{2500}"} PRINT BUTTON {"\u{2500}"}{"\u{2500}"} */}
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
                                            .no-print { position:sticky;top:0;z-index:1000;background:#2563eb;padding:10px;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.3) }
                                            .no-print button { padding: 12px 24px; font-size: 16px; font-weight: bold; border: none; border-radius: 8px; cursor: pointer; margin: 0 6px; }
                                            .btn-print { background: white; color: #2563eb; } .btn-close { background: #ff4444; color: white; }
                                            @media print { body { padding: 10px; } .no-print { display: none !important; } }
                                        </style></head><body>`;
                                        html += `<div class="no-print"><button class="btn-close" onclick="try{window.close()}catch(e){} setTimeout(function(){if(!window.closed){window.location.href='https://ddmauapp.github.io/dd-mau-portal/'}},300)">✕ Close</button><button class="btn-print" onclick="window.print()">🖨️ Print</button></div>`;
                                        html += `<h1>\u{1F35C} DD Mau Break Plan</h1><div class="date">${today}</div>`;

                                        // Stations
                                        html += `<div class="section"><div class="section-header">\u{1F4CB} Today's Stations</div><div class="station-grid">`;
                                        ALL_POSITIONS.forEach(pos => {
                                            const person = breakPlan.stations?.[pos.id] || "\u{2014}";
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
                                                    const coverName = nc.cover ? nc.cover.split(" ")[0] : "\u{26A0}\u{FE0F} UNCOVERED";
                                                    html += `<div class="wave-row"><span>${nc.pos.emoji} ${nc.pos.nameEn} <span class="cover-label">(${nc.person.split(" ")[0]} on break)</span></span><span class="cover-name">\u{2192} ${coverName}</span></div>`;
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
                                        {"\u{1F5A8}"}{"\u{FE0F}"} {language === "es" ? "Imprimir Plan de Breaks" : "Print Break Plan"}
                                    </button>
                                );
                            })()}
                        </div>
                    )}

                    {activeTab === "prep" && (
                        <PrepList
                            language={language}
                            staffName={staffName}
                            storeLocation={storeLocation}
                            staffList={staffList}
                        />
                    )}
                </div>
            );
        }

        // Menu Reference Component
        function MenuReference({ language }) {
            const [expandedCategory, setExpandedCategory] = useState(null);

            return (
                <div className="p-4 pb-24">
                    <h2 className="text-2xl font-bold text-mint-700 mb-4">{"\u{1F35C}"} {t("menuReference", language)}</h2>

                    <div className="space-y-3">
                        {MENU_DATA.map((category, idx) => (
                            <div key={idx} className="bg-white rounded-lg border-2 border-gray-200 overflow-hidden">
                                <button
                                    onClick={() => setExpandedCategory(expandedCategory === idx ? null : idx)}
                                    className="w-full p-4 text-left bg-gradient-to-r from-mint-50 to-white hover:bg-mint-50 border-b flex justify-between items-center"
                                >
                                    <h3 className="font-bold text-lg text-mint-700">{language === "es" ? category.categoryEs : category.category}</h3>
                                    <span className="text-xl">{expandedCategory === idx ? "\u{25BC}" : "\u{25B6}"}</span>
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
                                                    {item.popular && <span className="bg-mint-100 text-mint-700 px-2 py-1 rounded">{"\u{2B50}"} {t("popular", language)}</span>}
                                                    {item.spicy && <span className="bg-orange-100 text-orange-700 px-2 py-1 rounded">{"\u{1F336}"} {t("spicy", language)}</span>}
                                                    {item.allergens && <span className="bg-yellow-100 text-yellow-700 px-2 py-1 rounded">{"\u{26A0}"} {item.allergens}</span>}
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
                    <h2 className="text-2xl font-bold text-mint-700 mb-2">{"\u{1F4C5}"} {t("weeklySchedule", language)}</h2>
                    <p className="text-gray-600 mb-4">{SCHEDULE_DATA.week} {"\u{2014}"} <span className="font-bold text-mint-700">{LOCATION_LABELS[storeLocation]}</span></p>

                    <div className="space-y-4">
                        {SCHEDULE_DATA.shifts.map((day, idx) => {
                            const filteredSchedule = filterByLocation(day.schedule);
                            return (
                            <div key={idx} className="bg-white rounded-lg border-2 border-gray-200 overflow-hidden">
                                <div className="p-4 bg-gradient-to-r from-mint-50 to-white border-b">
                                    <h3 className="font-bold text-lg text-mint-700">{day.day}</h3>
                                    {day.note && <p className="text-xs text-orange-600 mt-1">{"\u{1F4CC}"} {day.note}</p>}
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
                                                    {isCurrentStaff ? "\u{2713} " : ""}{entry.name}
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
                emoji: "\u{1F372}",
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
                    "10 lbs huesos de res (nudillo y tuétano)",
                    "2 lbs chuck de res",
                    "3 cebollas grandes, cortadas y asadas",
                    "6 pulgadas de jengibre, cortado y asado",
                    "5 vainas de anís estrella",
                    "6 clavos enteros",
                    "2 rajas de canela",
                    "1 cucharada de semillas de cilantro",
                    "1/4 taza de salsa de pescado",
                    "2 cucharadas de azúcar",
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
                    "Cool properly: ice bath to 70°F within 2 hours, then refrigerate."
                ],
                instructionsEs: [
                    "Blanquea los huesos en agua hirviendo 10 min, escurre y enjuaga.",
                    "Asa las cebollas y el jengibre bajo el asador hasta que estén ennegrecidos.",
                    "Tuesta anís estrella, clavos, canela, cilantro en sartén seco hasta que estén fragantes.",
                    "Agrega huesos y chuck a una olla grande, cubre con 7 galones de agua fría.",
                    "Lleva a hervor, luego reduce a fuego lento. Retira la espuma frecuentemente la primera hora.",
                    "Agrega cebollas asadas, jengibre y especias tostadas en bolsa de manta.",
                    "Cocina a fuego lento 12 horas mínimo, retirando espuma ocasionalmente.",
                    "Retira el chuck después de 1.5 horas (reserva para rebanar).",
                    "Cuela el caldo por malla fina. Sazona con salsa de pescado, azúcar, sal.",
                    "Enfría correctamente: baño de hielo a 21°C en 2 horas, luego refrigera."
                ]
            },
            {
                id: 2,
                titleEn: "Egg Rolls (Chả Giò)",
                titleEs: "Rollitos Fritos (Chả Giò)",
                emoji: "\u{1F95F}",
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
                    "1 lb camarón, picado",
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
                    "Heat oil to 325°F for first fry (5 min until light golden). Drain on rack.",
                    "Increase oil to 350°F. Second fry 2-3 min until deep golden and crispy.",
                    "Internal temp must reach 165°F. Check 3 rolls per batch.",
                    "Serve with nước chấm dipping sauce and lettuce wraps."
                ],
                instructionsEs: [
                    "Mezcla cerdo, camarón, fideos, hongos, zanahoria, taro, cebolla en un tazón grande.",
                    "Agrega huevos, salsa de pescado y pimienta. Mezcla bien a mano.",
                    "Coloca 2 cucharadas de relleno en cada masa. Enrolla firmemente, sella con huevo batido.",
                    "Calienta aceite a 163°C para primera fritura (5 min hasta dorado claro). Escurre en rejilla.",
                    "Sube aceite a 177°C. Segunda fritura 2-3 min hasta dorado profundo y crujiente.",
                    "La temperatura interna debe alcanzar 74°C. Revisa 3 rollitos por lote.",
                    "Sirve con salsa nước chấm y hojas de lechuga."
                ]
            },
            {
                id: 3,
                titleEn: "Nước Chấm (Dipping Sauce)",
                titleEs: "Nước Chấm (Salsa para Mojar)",
                emoji: "\u{1FAD9}",
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
                    "1 taza de azúcar",
                    "2 tazas de agua tibia",
                    "1/2 taza de jugo de limón (fresco)",
                    "4 dientes de ajo, picados",
                    "2 chiles Thai, picados",
                    "2 cucharadas de zanahoria rallada (guarnición)"
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
                    "Disuelve el azúcar en agua tibia completamente.",
                    "Agrega salsa de pescado y jugo de limón. Mezcla para combinar.",
                    "Agrega ajo picado y chiles Thai.",
                    "Prueba y ajusta: más azúcar si está muy salado, más limón si está muy dulce.",
                    "Decora con zanahoria rallada. Refrigera.",
                    "Se conserva 5 días refrigerado. Etiqueta con fecha de preparación."
                ]
            },
            {
                id: 4,
                titleEn: "Vietnamese Iced Coffee (Cà Phê Sữa Đá)",
                titleEs: "Café Vietnamita Helado (Cà Phê Sữa Đá)",
                emoji: "\u{2615}",
                category: "Drinks",
                prepTimeEn: "5 min", cookTimeEn: "4 min drip",
                yieldsEn: "1 serving", yieldsEs: "1 porción",
                ingredientsEn: [
                    "2 tbsp Vietnamese ground coffee (Trung Nguyen or Café Du Monde)",
                    "2-3 tbsp sweetened condensed milk",
                    "6 oz boiling water",
                    "Ice to fill glass",
                    "Phin filter (Vietnamese drip filter)"
                ],
                ingredientsEs: [
                    "2 cucharadas de café molido vietnamita (Trung Nguyen o Café Du Monde)",
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
                    "Coloca el filtro phin encima del vaso. Agrega café molido, presiona ligeramente.",
                    "Vierte una pequeña cantidad de agua caliente para florecer (30 segundos).",
                    "Llena el phin con el agua caliente restante. Tapa y deja gotear (4-5 min).",
                    "Una vez goteado, mezcla el café y la leche condensada.",
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
                titleEn: "", titleEs: "", emoji: "\u{1F37D}\u{FE0F}", category: "",
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
                if (!form.titleEn.trim()) { alert(language === "es" ? "Se requiere título en inglés" : "English title is required"); return; }
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
                            <button onClick={() => removeListItem(field, i)} className="text-red-400 text-sm px-1">{"\u{2715}"}</button>
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
                                <label className="block text-xs font-bold text-gray-600 mb-1">{language === "es" ? "Ícono" : "Emoji"}</label>
                                <input className="w-full border border-gray-300 rounded px-2 py-1 text-center text-xl" value={form.emoji} onChange={e => updateField("emoji", e.target.value)} />
                            </div>
                            <div className="flex-1">
                                <label className="block text-xs font-bold text-gray-600 mb-1">{language === "es" ? "Categoría" : "Category"}</label>
                                <input className="w-full border border-gray-300 rounded px-2 py-1 text-sm" value={form.category} onChange={e => updateField("category", e.target.value)} placeholder={language === "es" ? "ej. Sopas, Aperitivos, Salsas" : "e.g. Soups, Appetizers, Sauces"} />
                            </div>
                        </div>

                        <div>
                            <label className="block text-xs font-bold text-gray-600 mb-1">{language === "es" ? "Título (Inglés) *" : "Title (English) *"}</label>
                            <input className="w-full border border-gray-300 rounded px-2 py-1 text-sm" value={form.titleEn} onChange={e => updateField("titleEn", e.target.value)} placeholder={language === "es" ? "Nombre de la receta en inglés" : "Recipe name in English"} />
                        </div>
                        <div>
                            <label className="block text-xs font-bold text-gray-600 mb-1">{language === "es" ? "Título (Español)" : "Title (Spanish)"}</label>
                            <input className="w-full border border-gray-300 rounded px-2 py-1 text-sm" value={form.titleEs} onChange={e => updateField("titleEs", e.target.value)} placeholder={language === "es" ? "Nombre en español" : "Recipe name in Spanish"} />
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
                            <h3 className="font-bold text-sm text-amber-800 mb-2">{"\u{1F4DD}"} {t("ingredients", language)}</h3>
                            {renderListEditor("ingredientsEn", language === "es" ? "Inglés" : "English")}
                            {renderListEditor("ingredientsEs", language === "es" ? "Español" : "Spanish")}
                        </div>

                        <div className="border-t pt-3 mt-3">
                            <h3 className="font-bold text-sm text-amber-800 mb-2">{"\u{1F468}"}{"\u{200D}"}{"\u{1F373}"} {t("instructions", language)}</h3>
                            {renderListEditor("instructionsEn", language === "es" ? "Inglés" : "English")}
                            {renderListEditor("instructionsEs", language === "es" ? "Español" : "Spanish")}
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

