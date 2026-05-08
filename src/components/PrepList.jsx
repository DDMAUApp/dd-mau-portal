import { useState, useEffect, useRef, useCallback } from 'react';
import { db } from '../firebase';
import { doc, setDoc, onSnapshot, query } from 'firebase/firestore';
import { PREP_STATIONS } from '../data/prepList';
import { INVENTORY_CATEGORIES } from '../data/inventory';
import { isAdmin } from '../data/staff';

// Debounce helper — delays Firestore writes until tapping stops
function useDebounce(fn, delay) {
    const timerRef = useRef(null);
    const fnRef = useRef(fn);
    fnRef.current = fn;
    const debounced = useCallback((...args) => {
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => fnRef.current(...args), delay);
    }, [delay]);
    useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);
    return debounced;
}

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_LABELS_ES = ["Dom", "Lun", "Mar", "Mie", "Jue", "Vie", "Sab"];

export default function PrepList({ language, staffName, storeLocation, staffList }) {
    const [stations, setStations] = useState(PREP_STATIONS.map(s => ({ ...s, items: s.items.map(i => ({ ...i })) })));
    const [onHand, setOnHand] = useState({});
    const [doneItems, setDoneItems] = useState({});
    const [prepMeta, setPrepMeta] = useState({});
    const [busyMode, setBusyMode] = useState(false);
    const [showCart, setShowCart] = useState(false);
    const [showCalendar, setShowCalendar] = useState(false);
    const [editingItem, setEditingItem] = useState(null);
    const [ingredientSearch, setIngredientSearch] = useState("");
    const [collapsedStations, setCollapsedStations] = useState({});
    const [prepSearch, setPrepSearch] = useState("");
    const [selectedDay, setSelectedDay] = useState(new Date().getDay());
    const [showOnlyToday, setShowOnlyToday] = useState(false);
    const [showPrepSheet, setShowPrepSheet] = useState(false);
    const [prepSheetDay, setPrepSheetDay] = useState(new Date().getDay());
    const [editingPrepItem, setEditingPrepItem] = useState(null); // { stationId, itemId, name, nameEs, unit, slowPar, busyPar }
    const [addingToStation, setAddingToStation] = useState(null); // stationId
    const [newPrepName, setNewPrepName] = useState("");
    const [newPrepNameEs, setNewPrepNameEs] = useState("");
    const [newPrepUnit, setNewPrepUnit] = useState("");
    const [newPrepSlowPar, setNewPrepSlowPar] = useState("");
    const [newPrepBusyPar, setNewPrepBusyPar] = useState("");

    const currentIsManager = isAdmin(staffName, staffList) || (staffList || []).some(s => s.name === staffName && (s.role === "manager" || s.role === "admin"));

    // Load from Firestore
    useEffect(() => {
        const unsub = onSnapshot(doc(db, "ops", "prepList_" + storeLocation), (snap) => {
            if (snap.exists()) {
                const data = snap.data();
                if (data.onHand) setOnHand(data.onHand);
                if (data.doneItems) setDoneItems(data.doneItems);
                if (data.prepMeta) setPrepMeta(data.prepMeta);
                if (data.busyMode !== undefined) setBusyMode(data.busyMode);
                if (data.customStations) {
                    // Merge saved data with master list
                    const merged = PREP_STATIONS.map(masterSt => {
                        const savedSt = data.customStations.find(ss => ss.id === masterSt.id);
                        if (!savedSt) return { ...masterSt, items: masterSt.items.map(i => ({ ...i })) };
                        const mergedItems = masterSt.items.map(mi => {
                            const savedItem = savedSt.items.find(si => si.id === mi.id);
                            return savedItem ? { ...mi, ...savedItem, name: mi.name, nameEs: mi.nameEs } : { ...mi };
                        });
                        savedSt.items.forEach(si => {
                            if (!masterSt.items.find(mi => mi.id === si.id)) mergedItems.push(si);
                        });
                        return { ...masterSt, items: mergedItems };
                    });
                    data.customStations.forEach(ss => {
                        if (!PREP_STATIONS.find(ms => ms.id === ss.id)) merged.push(ss);
                    });
                    setStations(merged);
                }
            }
        });
        return () => unsub();
    }, [storeLocation]);

    const savePrepRaw = async (newOnHand, newDone, newMeta, newStations, newBusy) => {
        try {
            await setDoc(doc(db, "ops", "prepList_" + storeLocation), {
                onHand: newOnHand || onHand,
                doneItems: newDone || doneItems,
                prepMeta: newMeta || prepMeta,
                customStations: newStations || stations,
                busyMode: newBusy !== undefined ? newBusy : busyMode,
                date: new Date().toISOString()
            });
        } catch (err) { console.error("Error saving prep:", err); }
    };
    // Debounced version for rapid count changes (500ms delay)
    const savePrepDebounced = useDebounce(savePrepRaw, 500);
    // Immediate save for non-count changes
    const savePrep = savePrepRaw;

    const updateOnHand = (itemId, val) => {
        const updated = { ...onHand, [itemId]: Math.max(0, val) };
        setOnHand(updated);
        savePrepDebounced(updated, null, null, null);
    };

    const toggleDone = (itemId) => {
        const now = new Date();
        const newDone = { ...doneItems, [itemId]: !doneItems[itemId] };
        const newMeta = { ...prepMeta };
        if (newDone[itemId]) {
            newMeta[itemId] = { by: staffName, at: now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) };
        } else {
            delete newMeta[itemId];
        }
        setDoneItems(newDone);
        setPrepMeta(newMeta);
        savePrep(null, newDone, newMeta, null);
    };

    const toggleBusy = () => {
        const newBusy = !busyMode;
        setBusyMode(newBusy);
        savePrep(null, null, null, null, newBusy);
    };

    const updateIngredients = (stationId, itemId, newIngredients) => {
        const updated = stations.map(st =>
            st.id === stationId ? {
                ...st, items: st.items.map(it =>
                    it.id === itemId ? { ...it, ingredients: newIngredients } : it
                )
            } : st
        );
        setStations(updated);
        savePrep(null, null, null, updated);
    };

    const updatePrepDays = (stationId, itemId, newDays) => {
        const updated = stations.map(st =>
            st.id === stationId ? {
                ...st, items: st.items.map(it =>
                    it.id === itemId ? { ...it, prepDays: newDays } : it
                )
            } : st
        );
        setStations(updated);
        savePrep(null, null, null, updated);
    };

    const resetDay = async () => {
        if (!window.confirm(language === "es" ? "Reiniciar todos los conteos y marcas de hoy?" : "Reset all counts and checkmarks for today?")) return;
        const emptyOnHand = {};
        const emptyDone = {};
        const emptyMeta = {};
        setOnHand(emptyOnHand);
        setDoneItems(emptyDone);
        setPrepMeta(emptyMeta);
        try {
            await setDoc(doc(db, "ops", "prepList_" + storeLocation), {
                onHand: emptyOnHand,
                doneItems: emptyDone,
                prepMeta: emptyMeta,
                customStations: stations,
                busyMode: busyMode,
                date: new Date().toISOString()
            });
        } catch (err) { console.error("Error resetting prep:", err); }
    };

    const saveEditPrepItem = () => {
        if (!editingPrepItem) return;
        const updated = stations.map(st =>
            st.id === editingPrepItem.stationId ? {
                ...st, items: st.items.map(it =>
                    it.id === editingPrepItem.itemId ? { ...it, name: editingPrepItem.name, nameEs: editingPrepItem.nameEs, unit: editingPrepItem.unit, slowPar: editingPrepItem.slowPar, busyPar: editingPrepItem.busyPar } : it
                )
            } : st
        );
        setStations(updated);
        savePrep(null, null, null, updated);
        setEditingPrepItem(null);
    };

    const deletePrepItem = (stationId, itemId) => {
        const updated = stations.map(st =>
            st.id === stationId ? { ...st, items: st.items.filter(it => it.id !== itemId) } : st
        );
        setStations(updated);
        savePrep(null, null, null, updated);
        setEditingPrepItem(null);
    };

    const addPrepItem = (stationId) => {
        if (!newPrepName.trim()) return;
        const newId = "custom_" + Date.now();
        const newItem = {
            id: newId,
            name: newPrepName.trim(),
            nameEs: newPrepNameEs.trim() || newPrepName.trim(),
            slowPar: newPrepSlowPar || "0",
            busyPar: newPrepBusyPar || "0",
            unit: newPrepUnit.trim() || "ea",
            ingredients: [],
            prepDays: [1, 2, 3, 4, 5, 6]
        };
        const updated = stations.map(st =>
            st.id === stationId ? { ...st, items: [...st.items, newItem] } : st
        );
        setStations(updated);
        savePrep(null, null, null, updated);
        setAddingToStation(null);
        setNewPrepName("");
        setNewPrepNameEs("");
        setNewPrepUnit("");
        setNewPrepSlowPar("");
        setNewPrepBusyPar("");
    };

    // Get all inventory items as flat list for ingredient picker
    const allInventoryItems = [];
    INVENTORY_CATEGORIES.forEach(cat => {
        cat.items.forEach(item => {
            allInventoryItems.push({ ...item, catName: cat.name });
        });
    });

    // Calculate need for an item
    const getItemNeed = (item) => {
        const par = busyMode ? item.busyPar : item.slowPar;
        const parNum = parseFloat(par) || 0;
        const hand = onHand[item.id] || 0;
        return Math.max(0, parNum - hand);
    };

    // Get items needing prep today
    const getTodayItems = () => {
        const today = new Date().getDay();
        const items = [];
        stations.forEach(st => {
            st.items.forEach(item => {
                if (item.prepDays && item.prepDays.includes(today)) {
                    items.push({ ...item, stationName: st.name, stationNameEs: st.nameEs });
                }
            });
        });
        return items;
    };

    // Get all ingredients needed from cart (items that need prep)
    const getCartIngredients = () => {
        const ingredientMap = {};
        stations.forEach(st => {
            st.items.forEach(item => {
                const need = getItemNeed(item);
                if (need > 0 && item.ingredients && item.ingredients.length > 0) {
                    item.ingredients.forEach(invId => {
                        const invItem = allInventoryItems.find(i => i.id === invId);
                        if (invItem) {
                            if (!ingredientMap[invId]) {
                                ingredientMap[invId] = { ...invItem, usedBy: [], totalNeedItems: 0 };
                            }
                            ingredientMap[invId].usedBy.push(item.name);
                            ingredientMap[invId].totalNeedItems++;
                        }
                    });
                }
            });
        });
        return Object.values(ingredientMap);
    };

    // Get items for a specific day of week
    const getItemsForDay = (dayNum) => {
        const items = [];
        stations.forEach(st => {
            st.items.forEach(item => {
                if (item.prepDays && item.prepDays.includes(dayNum)) {
                    items.push({ ...item, stationName: st.name, stationNameEs: st.nameEs, stationId: st.id });
                }
            });
        });
        return items;
    };

    const toggleCollapse = (key) => {
        setCollapsedStations(prev => ({ ...prev, [key]: !prev[key] }));
    };

    // Print cart - weekly prep items calendar view
    const printCart = () => {
        const now = new Date();
        const dateStr = now.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
        const timeStr = now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
        const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
        let html = `<html><head><title>DD Mau Weekly Prep List</title><style>
            body{font-family:Arial,sans-serif;max-width:900px;margin:0 auto;padding:20px;color:#333}
            h1{font-size:20px;color:#7c3aed;margin-bottom:4px}
            .date{font-size:12px;color:#888;margin-bottom:16px}
            .day-header{background:#7c3aed;color:white;padding:10px 14px;font-weight:bold;font-size:16px;margin-top:24px;border-radius:8px 8px 0 0;display:flex;justify-content:space-between;align-items:center}
            .day-header .count{background:rgba(255,255,255,0.25);padding:2px 10px;border-radius:12px;font-size:13px}
            .day-empty{padding:12px 14px;color:#aaa;font-size:13px;border:1px solid #e0e0e0;border-top:none;border-radius:0 0 8px 8px}
            .station{background:#ede9fe;padding:5px 12px;font-weight:bold;font-size:11px;color:#7c3aed;text-transform:uppercase;border:1px solid #ccc;border-top:none}
            table{width:100%;border-collapse:collapse}
            td{padding:6px 10px;font-size:12px;border:1px solid #e0e0e0}
            tr:nth-child(even){background:#f9f9f9}
            .unit{font-size:10px;color:#888}
            .no-print{position:sticky;top:0;z-index:1000;background:#7c3aed;padding:10px;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.3)}
            .no-print button{padding:12px 24px;font-size:16px;font-weight:bold;border:none;border-radius:8px;cursor:pointer;margin:0 6px}
            .btn-print{background:white;color:#7c3aed} .btn-close{background:#ff4444;color:white}
            @media print{.no-print{display:none !important} .day-header,.station{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
        </style></head><body>`;
        html += `<div class="no-print"><button class="btn-close" onclick="try{window.close()}catch(e){} setTimeout(function(){if(!window.closed){window.location.href='https://ddmauapp.github.io/dd-mau-portal/'}},300)">\u{2715} Close</button><button class="btn-print" onclick="window.print()">\u{1F5A8}\u{FE0F} Print</button></div>`;
        html += `<h1>DD Mau Weekly Prep List</h1><div class="date">${dateStr} at ${timeStr} - ${storeLocation}</div>`;
        days.forEach((dayName, dayIdx) => {
            const dayItems = getItemsForDay(dayIdx).filter(item => doneItems[item.id]);
            const isToday = dayIdx === now.getDay();
            if (dayItems.length === 0) return;
            html += `<div class="day-header" style="${isToday ? "background:#059669" : ""}">${dayName}${isToday ? " (TODAY)" : ""}<span class="count">${dayItems.length} items</span></div>`;
            {
                const byStation = {};
                dayItems.forEach(item => {
                    const key = item.stationName;
                    if (!byStation[key]) byStation[key] = [];
                    byStation[key].push(item);
                });
                Object.entries(byStation).sort(([a],[b]) => a.localeCompare(b)).forEach(([stName, items]) => {
                    html += `<div class="station">${stName} (${items.length})</div>`;
                    html += `<table>`;
                    items.sort((a, b) => a.name.localeCompare(b.name)).forEach(item => {
                        html += `<tr><td>${item.name}</td><td class="unit">${item.unit || ""}</td><td style="width:30px"></td></tr>`;
                    });
                    html += `</table>`;
                });
            }
        });
        // buttons are in sticky top bar
        html += `</body></html>`;
        const w = window.open("", "_blank");
        if (!w) {
            alert(language === "es" ? "Por favor permita ventanas emergentes para imprimir." : "Please allow pop-ups to print.");
            return;
        }
        w.document.write(html);
        w.document.close();
        w.print();
    };

    // Print prep sheet for a specific day
    const printPrepSheet = (dayNum) => {
        const dayItems = getItemsForDay(dayNum);
        const now = new Date();
        const dateStr = now.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
        const timeStr = now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
        const dayName = DAY_LABELS[dayNum];
        const byStation = {};
        dayItems.forEach(item => {
            const key = item.stationName;
            if (!byStation[key]) byStation[key] = [];
            byStation[key].push(item);
        });
        let html = `<html><head><title>DD Mau Prep Sheet - ${dayName}</title><style>
            body{font-family:Arial,sans-serif;max-width:800px;margin:0 auto;padding:20px;color:#333}
            h1{font-size:20px;color:#7c3aed;margin-bottom:4px}
            .date{font-size:12px;color:#888;margin-bottom:16px}
            .station{background:#7c3aed;color:white;padding:8px 12px;font-weight:bold;font-size:14px;margin-top:16px;border-radius:6px 6px 0 0}
            table{width:100%;border-collapse:collapse;margin-bottom:12px}
            th{background:#ede9fe;padding:6px 10px;text-align:left;font-size:11px;color:#7c3aed;border:1px solid #ccc}
            td{padding:6px 10px;font-size:12px;border:1px solid #e0e0e0}
            tr:nth-child(even){background:#f9f9f9}
            .no-print{position:sticky;top:0;z-index:1000;background:#7c3aed;padding:10px;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.3)}
            .no-print button{padding:12px 24px;font-size:16px;font-weight:bold;border:none;border-radius:8px;cursor:pointer;margin:0 6px}
            .btn-print{background:white;color:#7c3aed} .btn-close{background:#ff4444;color:white}
            @media print{.no-print{display:none !important}}
        </style></head><body>`;
        html += `<div class="no-print"><button class="btn-close" onclick="try{window.close()}catch(e){} setTimeout(function(){if(!window.closed){window.location.href='https://ddmauapp.github.io/dd-mau-portal/'}},300)">\u{2715} Close</button><button class="btn-print" onclick="window.print()">\u{1F5A8}\u{FE0F} Print</button></div>`;
        html += `<h1>DD Mau Prep Sheet - ${dayName}</h1><div class="date">${dateStr} at ${timeStr} - ${storeLocation} - ${busyMode ? "BUSY" : "SLOW"} day</div>`;
        html += `<p style="font-size:13px;color:#555;margin-bottom:12px"><strong>${dayItems.length}</strong> items to prep</p>`;
        Object.entries(byStation).sort(([a],[b]) => a.localeCompare(b)).forEach(([stName, items]) => {
            html += `<div class="station">${stName} (${items.length})</div>`;
            html += `<table><tr><th>Item</th><th>Unit</th><th style="width:30px">\u2713</th></tr>`;
            items.sort((a, b) => a.name.localeCompare(b.name)).forEach(item => {
                html += `<tr><td>${item.name}</td><td>${item.unit || ""}</td><td></td></tr>`;
            });
            html += `</table>`;
        });
        // buttons are in sticky top bar
        html += `</body></html>`;
        const w = window.open("", "_blank");
        if (!w) {
            alert(language === "es" ? "Por favor permita ventanas emergentes para imprimir." : "Please allow pop-ups to print.");
            return;
        }
        w.document.write(html);
        w.document.close();
        w.print();
    };

    // Count stats
    let totalItems = 0, totalDone = 0, totalNeed = 0;
    stations.forEach(st => {
        st.items.forEach(item => {
            totalItems++;
            if (doneItems[item.id]) totalDone++;
            if (getItemNeed(item) > 0) totalNeed++;
        });
    });
    const cartIngredients = getCartIngredients();
    const searchLower = prepSearch.toLowerCase().trim();

    return (
        <div className="space-y-3 px-2">
            {/* Header controls */}
            <div className="flex items-center gap-2 flex-wrap">
                <button onClick={toggleBusy}
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold transition ${busyMode ? "bg-red-600 text-white" : "bg-green-600 text-white"}`}>
                    {busyMode ? (language === "es" ? "Ocupado" : "Busy Day") : (language === "es" ? "Lento" : "Slow Day")}
                </button>
                <button onClick={() => setShowOnlyToday(!showOnlyToday)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold transition ${showOnlyToday ? "bg-purple-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}>
                    {language === "es" ? "Solo Hoy" : "Today Only"}
                </button>
                <button onClick={() => setShowCalendar(!showCalendar)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold transition ${showCalendar ? "bg-indigo-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}>
                    {"\u{1F4C5}"} {language === "es" ? "Semana" : "Week"}
                </button>
                <button onClick={() => setShowPrepSheet(!showPrepSheet)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold transition ${showPrepSheet ? "bg-teal-600 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}>
                    {"\u{1F4CB}"} {language === "es" ? "Lista" : "Prep Sheet"}
                </button>
                {currentIsManager && (
                    <button onClick={resetDay}
                        className="px-3 py-1.5 rounded-lg text-xs font-bold bg-gray-100 text-gray-600 hover:bg-gray-200 transition">
                        {"\u{1F504}"} {language === "es" ? "Reiniciar" : "Reset Day"}
                    </button>
                )}
            </div>

            {/* Search */}
            <div className="relative">
                <span className="absolute left-3 top-2.5 text-gray-400">{"\u{1F50D}"}</span>
                <input type="text" value={prepSearch} onChange={e => setPrepSearch(e.target.value)}
                    placeholder={language === "es" ? "Buscar prep..." : "Search prep..."}
                    className="w-full pl-9 pr-3 py-2 border border-gray-200 rounded-xl text-sm bg-white focus:outline-none focus:border-purple-500" />
            </div>

            {/* Cart summary bar */}
            <div onClick={() => setShowCart(true)}
                className="bg-gradient-to-r from-purple-600 to-purple-500 text-white rounded-xl p-3 flex justify-between items-center cursor-pointer active:scale-[0.98] transition shadow-md">
                <div className="flex items-center gap-2">
                    <span className="text-lg">{"\u{1F4CB}"}</span>
                    <div>
                        <span className="font-bold text-sm">{totalDone} {language === "es" ? "items seleccionados" : "items selected"}</span>
                        <span className="text-purple-200 text-xs ml-2">{language === "es" ? "toca para ver/imprimir" : "tap to view/print"}</span>
                    </div>
                </div>
                <span className="text-xs bg-white/20 px-2 py-1 rounded-lg">{language === "es" ? "ver" : "view"} {"\u{25B8}"}</span>
            </div>

            {/* Calendar Week View */}
            {showCalendar && (
                <div className="bg-white rounded-xl border-2 border-indigo-200 overflow-hidden shadow-sm">
                    <div className="bg-gradient-to-r from-indigo-600 to-indigo-500 text-white px-4 py-2 flex justify-between items-center">
                        <span className="font-bold text-sm">{"\u{1F4C5}"} {language === "es" ? "Vista Semanal" : "Weekly View"}</span>
                        <button onClick={() => setShowCalendar(false)} className="text-white/70 hover:text-white">{"\u{2715}"}</button>
                    </div>
                    <div className="grid grid-cols-7 gap-0 border-b border-gray-200">
                        {DAY_LABELS.map((day, idx) => {
                            const dayItems = getItemsForDay(idx);
                            const isToday = idx === new Date().getDay();
                            const isSelected = idx === selectedDay;
                            return (
                                <button key={idx} onClick={() => setSelectedDay(idx)}
                                    className={`py-2 text-center border-r border-gray-100 last:border-r-0 transition ${isSelected ? "bg-indigo-100" : ""} ${isToday ? "font-bold" : ""}`}>
                                    <div className={`text-xs font-bold ${isToday ? "text-indigo-700" : "text-gray-500"}`}>
                                        {language === "es" ? DAY_LABELS_ES[idx] : day}
                                    </div>
                                    <div className={`text-lg font-bold ${isToday ? "text-indigo-700" : "text-gray-700"}`}>{dayItems.length}</div>
                                    <div className="text-xs text-gray-400">{language === "es" ? "items" : "items"}</div>
                                </button>
                            );
                        })}
                    </div>
                    {/* Selected day details */}
                    <div className="max-h-60 overflow-y-auto">
                        {(() => {
                            const dayItems = getItemsForDay(selectedDay);
                            // Group by station
                            const byStation = {};
                            dayItems.forEach(item => {
                                const key = item.stationName;
                                if (!byStation[key]) byStation[key] = { nameEs: item.stationNameEs, items: [] };
                                byStation[key].items.push(item);
                            });
                            return Object.entries(byStation).map(([stName, st]) => (
                                <div key={stName}>
                                    <div className="px-3 py-1 bg-gray-50 border-b border-gray-100">
                                        <span className="text-xs font-bold text-gray-500 uppercase">{language === "es" ? st.nameEs : stName}</span>
                                    </div>
                                    {st.items.map(item => (
                                        <div key={item.id} className="px-3 py-1.5 flex justify-between items-center border-b border-gray-50 text-sm">
                                            <span className={doneItems[item.id] ? "line-through text-gray-400" : "text-gray-800"}>
                                                {language === "es" && item.nameEs ? item.nameEs : item.name}
                                            </span>
                                            <span className="text-xs text-gray-400">{busyMode ? item.busyPar : item.slowPar}</span>
                                        </div>
                                    ))}
                                </div>
                            ));
                        })()}
                    </div>
                </div>
            )}

            {/* Prep Sheet Panel */}
            {showPrepSheet && (
                <div className="bg-white rounded-xl border-2 border-teal-200 overflow-hidden shadow-sm">
                    <div className="bg-gradient-to-r from-teal-600 to-teal-500 text-white px-4 py-2 flex justify-between items-center">
                        <span className="font-bold text-sm">{"\u{1F4CB}"} {language === "es" ? "Lista de Prep" : "Prep Sheet"}</span>
                        <div className="flex items-center gap-2">
                            <button onClick={() => printPrepSheet(prepSheetDay)} className="text-xs bg-white/20 px-2 py-1 rounded-lg hover:bg-white/30 transition">{"\u{1F5A8}\u{FE0F}"} {language === "es" ? "Imprimir" : "Print"}</button>
                            <button onClick={() => setShowPrepSheet(false)} className="text-white/70 hover:text-white">{"\u{2715}"}</button>
                        </div>
                    </div>
                    {/* Day selector */}
                    <div className="grid grid-cols-7 gap-0 border-b border-gray-200">
                        {DAY_LABELS.map((day, idx) => {
                            const dayItems = getItemsForDay(idx);
                            const isToday = idx === new Date().getDay();
                            const isSelected = idx === prepSheetDay;
                            return (
                                <button key={idx} onClick={() => setPrepSheetDay(idx)}
                                    className={`py-2 text-center border-r border-gray-100 last:border-r-0 transition ${isSelected ? "bg-teal-100 border-b-2 border-b-teal-600" : ""} ${isToday ? "font-bold" : ""}`}>
                                    <div className={`text-xs font-bold ${isSelected ? "text-teal-700" : isToday ? "text-teal-600" : "text-gray-500"}`}>
                                        {language === "es" ? DAY_LABELS_ES[idx] : day}
                                    </div>
                                    <div className={`text-lg font-bold ${isSelected ? "text-teal-700" : "text-gray-700"}`}>{dayItems.length}</div>
                                </button>
                            );
                        })}
                    </div>
                    {/* Items for selected day */}
                    <div className="max-h-[60vh] overflow-y-auto">
                        {(() => {
                            const dayItems = getItemsForDay(prepSheetDay);
                            if (dayItems.length === 0) return (
                                <div className="p-6 text-center text-gray-400 text-sm">{language === "es" ? "No hay items para este dia" : "No items scheduled for this day"}</div>
                            );
                            const byStation = {};
                            dayItems.forEach(item => {
                                const key = item.stationName;
                                if (!byStation[key]) byStation[key] = { nameEs: item.stationNameEs, items: [] };
                                byStation[key].items.push(item);
                            });
                            return Object.entries(byStation).sort(([a],[b]) => a.localeCompare(b)).map(([stName, st]) => (
                                <div key={stName}>
                                    <div className="px-3 py-1.5 bg-teal-50 border-b border-teal-100 flex justify-between items-center">
                                        <span className="text-xs font-bold text-teal-700 uppercase">{language === "es" ? st.nameEs : stName}</span>
                                        <span className="text-xs text-teal-500">{st.items.length} {language === "es" ? "items" : "items"}</span>
                                    </div>
                                    {st.items.sort((a, b) => a.name.localeCompare(b.name)).map(item => {
                                        const isDone = doneItems[item.id];
                                        return (
                                            <div key={item.id} className={`px-3 py-2 flex items-center justify-between border-b border-gray-50 ${isDone ? "bg-green-50/60" : ""}`}>
                                                <div className="flex items-center gap-2 flex-1 min-w-0">
                                                    <button onClick={() => toggleDone(item.id)}
                                                        className={`w-6 h-6 rounded-md border-2 flex items-center justify-center flex-shrink-0 transition ${isDone ? "bg-green-600 border-green-600 text-white" : "border-gray-300 text-transparent hover:border-green-400"}`}>
                                                        {"\u{2713}"}
                                                    </button>
                                                    <span className={`text-sm truncate ${isDone ? "line-through text-gray-400" : "text-gray-800"}`}>
                                                        {language === "es" && item.nameEs ? item.nameEs : item.name}
                                                    </span>
                                                </div>
                                                <span className="text-xs text-gray-400 ml-2 flex-shrink-0">{item.unit || ""}</span>
                                            </div>
                                        );
                                    })}
                                </div>
                            ));
                        })()}
                    </div>
                    {/* Footer with count */}
                    {(() => {
                        const dayItems = getItemsForDay(prepSheetDay);
                        const doneCnt = dayItems.filter(i => doneItems[i.id]).length;
                        return dayItems.length > 0 ? (
                            <div className="border-t border-gray-200 px-4 py-2 bg-gray-50 flex justify-between items-center">
                                <span className="text-xs text-gray-500">{doneCnt}/{dayItems.length} {language === "es" ? "completados" : "completed"}</span>
                                <div className="w-32 h-2 bg-gray-200 rounded-full overflow-hidden">
                                    <div className="h-full bg-teal-500 rounded-full transition-all" style={{ width: (doneCnt / dayItems.length * 100) + "%" }} />
                                </div>
                            </div>
                        ) : null;
                    })()}
                </div>
            )}

            {/* Cart Modal - Weekly Prep Items */}
            {showCart && (
                <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-end sm:items-center justify-center" onClick={() => setShowCart(false)}>
                    <div className="bg-white w-full max-w-lg max-h-[90vh] rounded-t-2xl sm:rounded-2xl overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}>
                        <div className="bg-purple-700 text-white px-4 py-3 flex items-center justify-between flex-shrink-0">
                            <h3 className="font-bold text-lg">{"\u{1F4CB}"} {language === "es" ? "Prep de la Semana" : "Weekly Prep"}</h3>
                            <button onClick={() => setShowCart(false)} className="w-8 h-8 rounded-full bg-white bg-opacity-20 flex items-center justify-center text-white font-bold">{"\u{2715}"}</button>
                        </div>
                        <div className="flex-1 overflow-y-auto">
                            {(() => {
                                let hasAny = false;
                                const content = DAY_LABELS.map((dayLabel, dayIdx) => {
                                    const dayItems = getItemsForDay(dayIdx).filter(item => doneItems[item.id]);
                                    if (dayItems.length > 0) hasAny = true;
                                    const isToday = dayIdx === new Date().getDay();
                                    const byStation = {};
                                    dayItems.forEach(item => {
                                        const key = item.stationName;
                                        if (!byStation[key]) byStation[key] = { nameEs: item.stationNameEs, items: [] };
                                        byStation[key].items.push(item);
                                    });
                                    if (dayItems.length === 0) return null;
                                    return (
                                        <div key={dayIdx}>
                                            <div className={`px-4 py-2 font-bold text-sm flex justify-between items-center ${isToday ? "bg-green-600 text-white" : "bg-purple-600 text-white"}`}>
                                                <span>{language === "es" ? DAY_LABELS_ES[dayIdx] : dayLabel}{isToday ? (language === "es" ? " (HOY)" : " (TODAY)") : ""}</span>
                                                <span className="text-xs bg-white/20 px-2 py-0.5 rounded-full">{dayItems.length}</span>
                                            </div>
                                            {Object.entries(byStation).sort(([a],[b]) => a.localeCompare(b)).map(([stName, st]) => (
                                                <div key={stName}>
                                                    <div className="px-4 py-1 bg-gray-50 border-b border-gray-100">
                                                        <span className="text-[10px] font-bold text-purple-600 uppercase">{language === "es" ? st.nameEs : stName}</span>
                                                    </div>
                                                    {st.items.sort((a, b) => a.name.localeCompare(b.name)).map(item => (
                                                        <div key={item.id} className="px-4 py-1.5 flex items-center gap-2 border-b border-gray-50 bg-green-50/60">
                                                            <span className="w-5 h-5 rounded bg-green-600 text-white flex items-center justify-center flex-shrink-0 text-xs">{"\u{2713}"}</span>
                                                            <span className="text-sm flex-1 text-gray-800">
                                                                {language === "es" && item.nameEs ? item.nameEs : item.name}
                                                            </span>
                                                            <span className="text-xs text-gray-400">{item.unit || ""}</span>
                                                        </div>
                                                    ))}
                                                </div>
                                            ))}
                                        </div>
                                    );
                                });
                                if (!hasAny) return <div className="p-8 text-center text-gray-400">{language === "es" ? "Marca items con \u2713 para agregarlos aqui" : "Check off items with \u2713 to add them here"}</div>;
                                return content;
                            })()}
                        </div>
                        <div className="border-t border-gray-200 p-3 flex gap-2 flex-shrink-0 bg-gray-50">
                            <button onClick={printCart} className="flex-1 py-3 bg-purple-600 text-white rounded-xl font-bold text-sm hover:bg-purple-700 active:scale-95 transition">
                                {"\u{1F5A8}\u{FE0F}"} {language === "es" ? "Imprimir Semana" : "Print Week"}
                            </button>
                            <button onClick={() => setShowCart(false)} className="flex-1 py-3 bg-gray-200 text-gray-700 rounded-xl font-bold text-sm hover:bg-gray-300 active:scale-95 transition">
                                {"\u{2715}"} {language === "es" ? "Cerrar" : "Close"}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Ingredient Picker Modal */}
            {editingItem && (
                <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-end sm:items-center justify-center" onClick={() => setEditingItem(null)}>
                    <div className="bg-white w-full max-w-lg max-h-[85vh] rounded-t-2xl sm:rounded-2xl overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}>
                        <div className="bg-amber-600 text-white px-4 py-3 flex-shrink-0">
                            <div className="flex items-center justify-between">
                                <h3 className="font-bold text-base">{"\u{1F517}"} {language === "es" ? "Ingredientes de" : "Ingredients for"}: {editingItem.name}</h3>
                                <button onClick={() => setEditingItem(null)} className="w-8 h-8 rounded-full bg-white bg-opacity-20 flex items-center justify-center text-white font-bold">{"\u{2715}"}</button>
                            </div>
                            <input type="text" value={ingredientSearch} onChange={e => setIngredientSearch(e.target.value)}
                                placeholder={language === "es" ? "Buscar ingrediente..." : "Search inventory..."}
                                className="w-full mt-2 px-3 py-2 rounded-lg text-sm text-gray-800 bg-white focus:outline-none" />
                        </div>
                        <div className="flex-1 overflow-y-auto">
                            {/* Current ingredients */}
                            {editingItem.ingredients.length > 0 && (
                                <div>
                                    <div className="px-4 py-2 bg-green-50 text-green-800 text-xs font-bold uppercase">{language === "es" ? "Ingredientes Vinculados" : "Linked Ingredients"} ({editingItem.ingredients.length})</div>
                                    {editingItem.ingredients.map(invId => {
                                        const inv = allInventoryItems.find(i => i.id === invId);
                                        if (!inv) return null;
                                        return (
                                            <div key={invId} className="px-4 py-2 flex items-center justify-between border-b border-gray-100 bg-green-50/50">
                                                <div>
                                                    <span className="text-sm text-gray-800">{inv.name}</span>
                                                    <span className="text-xs text-gray-400 ml-2">{inv.catName}</span>
                                                </div>
                                                <button onClick={() => {
                                                    const newIngs = editingItem.ingredients.filter(id => id !== invId);
                                                    updateIngredients(editingItem.stationId, editingItem.id, newIngs);
                                                    setEditingItem({ ...editingItem, ingredients: newIngs });
                                                }} className="w-7 h-7 rounded-full bg-red-100 text-red-500 flex items-center justify-center text-sm hover:bg-red-200">{"\u{2212}"}</button>
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                            {/* Available items to add */}
                            <div className="px-4 py-2 bg-gray-50 text-gray-600 text-xs font-bold uppercase">{language === "es" ? "Agregar del Inventario" : "Add from Inventory"}</div>
                            {allInventoryItems
                                .filter(inv => {
                                    if (editingItem.ingredients.includes(inv.id)) return false;
                                    if (!ingredientSearch.trim()) return false;
                                    const s = ingredientSearch.toLowerCase();
                                    return (inv.name || "").toLowerCase().includes(s) || (inv.nameEs || "").toLowerCase().includes(s) || (inv.catName || "").toLowerCase().includes(s);
                                })
                                .slice(0, 30)
                                .map(inv => (
                                    <div key={inv.id} className="px-4 py-2 flex items-center justify-between border-b border-gray-50 hover:bg-gray-50 cursor-pointer"
                                        onClick={() => {
                                            const newIngs = [...editingItem.ingredients, inv.id];
                                            updateIngredients(editingItem.stationId, editingItem.id, newIngs);
                                            setEditingItem({ ...editingItem, ingredients: newIngs });
                                        }}>
                                        <div>
                                            <span className="text-sm text-gray-800">{inv.name}</span>
                                            <span className="text-xs text-gray-400 ml-2">{inv.catName}</span>
                                        </div>
                                        <span className="w-7 h-7 rounded-full bg-green-100 text-green-600 flex items-center justify-center text-lg font-bold">+</span>
                                    </div>
                                ))
                            }
                            {!ingredientSearch.trim() && (
                                <div className="p-6 text-center text-gray-400 text-sm">{language === "es" ? "Escribe para buscar ingredientes del inventario" : "Type to search inventory items"}</div>
                            )}
                        </div>
                        {/* Prep Days */}
                        <div className="border-t border-gray-200 px-4 py-3 bg-gray-50 flex-shrink-0">
                            <div className="text-xs font-bold text-gray-500 mb-2 uppercase">{language === "es" ? "Dias de Prep" : "Prep Days"}</div>
                            <div className="flex gap-1">
                                {DAY_LABELS.map((day, idx) => {
                                    const isActive = editingItem.prepDays.includes(idx);
                                    return (
                                        <button key={idx} onClick={() => {
                                            const newDays = isActive
                                                ? editingItem.prepDays.filter(d => d !== idx)
                                                : [...editingItem.prepDays, idx].sort();
                                            updatePrepDays(editingItem.stationId, editingItem.id, newDays);
                                            setEditingItem({ ...editingItem, prepDays: newDays });
                                        }}
                                            className={`flex-1 py-1.5 rounded text-xs font-bold transition ${isActive ? "bg-indigo-600 text-white" : "bg-gray-200 text-gray-500"}`}>
                                            {language === "es" ? DAY_LABELS_ES[idx] : day}
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Station List */}
            {stations.map((station, stIdx) => {
                let filteredItems = station.items;
                if (searchLower) {
                    filteredItems = filteredItems.filter(item =>
                        (item.name || "").toLowerCase().includes(searchLower) ||
                        (item.nameEs || "").toLowerCase().includes(searchLower)
                    );
                }
                if (showOnlyToday) {
                    const today = new Date().getDay();
                    filteredItems = filteredItems.filter(item => item.prepDays && item.prepDays.includes(today));
                }
                if (filteredItems.length === 0) return null;

                const stKey = "prep-" + stIdx;
                const isCollapsed = collapsedStations[stKey] && !searchLower;
                const doneCount = station.items.filter(i => doneItems[i.id]).length;

                return (
                    <div key={station.id} className="bg-white rounded-xl border border-gray-200 overflow-hidden shadow-sm">
                        <button onClick={() => toggleCollapse(stKey)}
                            className="w-full p-3 bg-gradient-to-r from-purple-700 to-purple-600 flex justify-between items-center">
                            <div className="flex items-center gap-2">
                                <span className="text-white text-sm font-bold">{language === "es" ? station.nameEs : station.name}</span>
                                <span className="bg-white/20 text-white text-xs px-2 py-0.5 rounded-full">{filteredItems.length}</span>
                            </div>
                            <div className="flex items-center gap-2">
                                {doneCount > 0 && <span className="bg-white text-purple-700 text-xs font-bold px-2 py-0.5 rounded-full">{doneCount}/{station.items.length} {"\u{2713}"}</span>}
                                <span className="text-white text-xs">{isCollapsed ? "\u{25B6}" : "\u{25BC}"}</span>
                            </div>
                        </button>
                        {!isCollapsed && (
                            <div>
                                {/* Column headers */}
                                <div className="flex items-center px-3 py-1.5 bg-gray-50 border-b border-gray-200 text-xs font-bold text-gray-500">
                                    <div className="flex-1">{language === "es" ? "Item" : "Item"}</div>
                                    <div className="w-16 text-center">{language === "es" ? "Par" : "Par"}</div>
                                    <div className="w-24 text-center">{language === "es" ? "En Mano" : "On Hand"}</div>
                                    <div className="w-10 text-center">{"\u{2713}"}</div>
                                </div>
                                <div className="divide-y divide-gray-100">
                                    {filteredItems.map(item => {
                                        const par = busyMode ? item.busyPar : item.slowPar;
                                        const hand = onHand[item.id] || 0;
                                        const need = getItemNeed(item);
                                        const isDone = doneItems[item.id];
                                        return (
                                            <div key={item.id} className={`px-3 py-2 ${isDone ? "bg-green-50/60" : need > 0 ? "bg-red-50/30" : ""}`}>
                                                <div className="flex items-center">
                                                    <div className="flex-1 min-w-0 pr-2">
                                                        <p className={`text-sm font-semibold truncate ${isDone ? "line-through text-gray-400" : "text-gray-800"}`}>
                                                            {language === "es" && item.nameEs ? item.nameEs : item.name}
                                                        </p>
                                                        <div className="flex items-center gap-1 mt-0.5 flex-wrap">
                                                            {need > 0 && <span className="text-xs bg-red-100 text-red-700 px-1.5 py-0.5 rounded font-bold">{language === "es" ? "Necesita" : "Need"}: {need}</span>}
                                                            {item.ingredients.length > 0 && (
                                                                <span className="text-xs bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded">{item.ingredients.length} {language === "es" ? "ing." : "ing."}</span>
                                                            )}
                                                            {currentIsManager && (
                                                                <button onClick={() => setEditingItem({ ...item, stationId: station.id })}
                                                                    className="text-xs px-1.5 py-0.5 rounded bg-blue-50 text-blue-600 font-medium hover:bg-blue-100 transition">
                                                                    {"\u{1F517}"} {language === "es" ? "Ing." : "Ing."}
                                                                </button>
                                                            )}
                                                            {currentIsManager && (
                                                                <button onClick={() => setEditingPrepItem({ stationId: station.id, itemId: item.id, name: item.name, nameEs: item.nameEs || "", unit: item.unit || "", slowPar: item.slowPar || "", busyPar: item.busyPar || "" })}
                                                                    className="text-xs px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 font-medium hover:bg-gray-200 transition">
                                                                    {"\u{270F}\u{FE0F}"}
                                                                </button>
                                                            )}
                                                            {prepMeta[item.id] && isDone && (
                                                                <span className="text-xs text-green-600">{"\u{2713}"} {prepMeta[item.id].by} {"\u{2014}"} {prepMeta[item.id].at}</span>
                                                            )}
                                                        </div>
                                                        {/* Prep Days inline */}
                                                        <div className="flex gap-0.5 mt-1">
                                                            {DAY_LABELS.map((day, idx) => {
                                                                const isActive = item.prepDays && item.prepDays.includes(idx);
                                                                return (
                                                                    <button key={idx}
                                                                        onClick={() => { if (currentIsManager) { const newDays = isActive ? (item.prepDays || []).filter(d => d !== idx) : [...(item.prepDays || []), idx].sort(); updatePrepDays(station.id, item.id, newDays); } }}
                                                                        className={`w-7 h-5 rounded text-[9px] font-bold transition ${isActive ? "bg-indigo-600 text-white" : "bg-gray-100 text-gray-400"} ${currentIsManager ? "hover:opacity-80 cursor-pointer" : "cursor-default"}`}>
                                                                        {language === "es" ? DAY_LABELS_ES[idx].charAt(0) : day.charAt(0)}
                                                                    </button>
                                                                );
                                                            })}
                                                        </div>
                                                    </div>
                                                    <div className="w-16 text-center">
                                                        <span className="text-xs text-gray-500 font-medium">{par}</span>
                                                    </div>
                                                    <div className="w-24 flex items-center justify-center gap-0.5">
                                                        <button onClick={() => updateOnHand(item.id, hand - 1)}
                                                            className={`w-7 h-7 rounded-md font-bold text-sm flex items-center justify-center transition ${hand > 0 ? "bg-red-100 text-red-700" : "bg-gray-100 text-gray-400"}`}>{"\u{2212}"}</button>
                                                        <span className={`w-8 text-center font-bold text-sm ${hand > 0 ? "text-green-700" : "text-gray-300"}`}>{hand}</span>
                                                        <button onClick={() => updateOnHand(item.id, hand + 1)}
                                                            className="w-7 h-7 rounded-md bg-green-100 text-green-700 font-bold text-sm flex items-center justify-center hover:bg-green-200">+</button>
                                                    </div>
                                                    <div className="w-10 flex justify-center">
                                                        <button onClick={() => toggleDone(item.id)}
                                                            className={`w-8 h-8 rounded-lg border-2 flex items-center justify-center transition ${isDone ? "bg-green-600 border-green-600 text-white" : "border-gray-300 text-transparent hover:border-green-400"}`}>
                                                            {"\u{2713}"}
                                                        </button>
                                                    </div>
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                                {/* Add item button */}
                                {currentIsManager && (
                                    <div className="border-t border-gray-200">
                                        {addingToStation === station.id ? (
                                            <div className="p-3 bg-gray-50 space-y-2">
                                                <input type="text" value={newPrepName} onChange={e => setNewPrepName(e.target.value)}
                                                    placeholder={language === "es" ? "Nombre del item" : "Item name"}
                                                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-purple-500" />
                                                <input type="text" value={newPrepNameEs} onChange={e => setNewPrepNameEs(e.target.value)}
                                                    placeholder={language === "es" ? "Nombre en espanol" : "Spanish name"}
                                                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-purple-500" />
                                                <div className="flex gap-2">
                                                    <input type="text" value={newPrepUnit} onChange={e => setNewPrepUnit(e.target.value)}
                                                        placeholder="Unit (ea, lb...)"
                                                        className="flex-1 px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-purple-500" />
                                                    <input type="text" value={newPrepSlowPar} onChange={e => setNewPrepSlowPar(e.target.value)}
                                                        placeholder="Slow par"
                                                        className="w-20 px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-purple-500" />
                                                    <input type="text" value={newPrepBusyPar} onChange={e => setNewPrepBusyPar(e.target.value)}
                                                        placeholder="Busy par"
                                                        className="w-20 px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-purple-500" />
                                                </div>
                                                <div className="flex gap-2">
                                                    <button onClick={() => addPrepItem(station.id)}
                                                        className="flex-1 py-2 bg-purple-600 text-white rounded-lg text-sm font-bold hover:bg-purple-700 transition">
                                                        {language === "es" ? "Agregar" : "Add Item"}
                                                    </button>
                                                    <button onClick={() => { setAddingToStation(null); setNewPrepName(""); setNewPrepNameEs(""); setNewPrepUnit(""); setNewPrepSlowPar(""); setNewPrepBusyPar(""); }}
                                                        className="px-4 py-2 bg-gray-200 text-gray-600 rounded-lg text-sm font-bold hover:bg-gray-300 transition">
                                                        {"\u{2715}"}
                                                    </button>
                                                </div>
                                            </div>
                                        ) : (
                                            <button onClick={() => { setAddingToStation(station.id); setNewPrepName(""); setNewPrepNameEs(""); setNewPrepUnit(""); setNewPrepSlowPar(""); setNewPrepBusyPar(""); }}
                                                className="w-full py-2 text-sm font-bold text-purple-600 hover:bg-purple-50 transition">
                                                + {language === "es" ? "Agregar Item" : "Add Item"}
                                            </button>
                                        )}
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                );
            })}

            {/* Edit Prep Item Modal */}
            {editingPrepItem && (
                <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-end sm:items-center justify-center" onClick={() => setEditingPrepItem(null)}>
                    <div className="bg-white w-full max-w-md rounded-t-2xl sm:rounded-2xl overflow-hidden" onClick={e => e.stopPropagation()}>
                        <div className="bg-gray-700 text-white px-4 py-3 flex items-center justify-between">
                            <h3 className="font-bold text-base">{"\u{270F}\u{FE0F}"} {language === "es" ? "Editar Item" : "Edit Item"}</h3>
                            <button onClick={() => setEditingPrepItem(null)} className="w-8 h-8 rounded-full bg-white bg-opacity-20 flex items-center justify-center text-white font-bold">{"\u{2715}"}</button>
                        </div>
                        <div className="p-4 space-y-3">
                            <div>
                                <label className="text-xs font-bold text-gray-500 uppercase">{language === "es" ? "Nombre" : "Name"}</label>
                                <input type="text" value={editingPrepItem.name} onChange={e => setEditingPrepItem({ ...editingPrepItem, name: e.target.value })}
                                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-purple-500 mt-1" />
                            </div>
                            <div>
                                <label className="text-xs font-bold text-gray-500 uppercase">{language === "es" ? "Nombre en Espanol" : "Spanish Name"}</label>
                                <input type="text" value={editingPrepItem.nameEs} onChange={e => setEditingPrepItem({ ...editingPrepItem, nameEs: e.target.value })}
                                    className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-purple-500 mt-1" />
                            </div>
                            <div className="flex gap-3">
                                <div className="flex-1">
                                    <label className="text-xs font-bold text-gray-500 uppercase">Unit</label>
                                    <input type="text" value={editingPrepItem.unit} onChange={e => setEditingPrepItem({ ...editingPrepItem, unit: e.target.value })}
                                        className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-purple-500 mt-1" />
                                </div>
                                <div className="w-24">
                                    <label className="text-xs font-bold text-gray-500 uppercase">Slow Par</label>
                                    <input type="text" value={editingPrepItem.slowPar} onChange={e => setEditingPrepItem({ ...editingPrepItem, slowPar: e.target.value })}
                                        className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-purple-500 mt-1" />
                                </div>
                                <div className="w-24">
                                    <label className="text-xs font-bold text-gray-500 uppercase">Busy Par</label>
                                    <input type="text" value={editingPrepItem.busyPar} onChange={e => setEditingPrepItem({ ...editingPrepItem, busyPar: e.target.value })}
                                        className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-purple-500 mt-1" />
                                </div>
                            </div>
                        </div>
                        <div className="border-t border-gray-200 p-3 flex gap-2 bg-gray-50">
                            <button onClick={saveEditPrepItem}
                                className="flex-1 py-3 bg-purple-600 text-white rounded-xl font-bold text-sm hover:bg-purple-700 active:scale-95 transition">
                                {language === "es" ? "Guardar" : "Save"}
                            </button>
                            <button onClick={() => { if (window.confirm(language === "es" ? "Eliminar este item?" : "Delete this item?")) deletePrepItem(editingPrepItem.stationId, editingPrepItem.itemId); }}
                                className="py-3 px-4 bg-red-100 text-red-600 rounded-xl font-bold text-sm hover:bg-red-200 active:scale-95 transition">
                                {"\u{1F5D1}"}
                            </button>
                            <button onClick={() => setEditingPrepItem(null)}
                                className="py-3 px-4 bg-gray-200 text-gray-600 rounded-xl font-bold text-sm hover:bg-gray-300 active:scale-95 transition">
                                {"\u{2715}"}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
