import { useState, useEffect } from 'react';
import { db } from '../firebase';
import { doc, setDoc, onSnapshot } from 'firebase/firestore';
import { PREP_STATIONS } from '../data/prepList';
import { INVENTORY_CATEGORIES } from '../data/inventory';
import { isAdmin } from '../data/staff';

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

    const currentIsManager = isAdmin(staffName) || (staffList || []).some(s => s.name === staffName && (s.role === "manager" || s.role === "admin"));

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

    const savePrep = async (newOnHand, newDone, newMeta, newStations, newBusy) => {
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

    const updateOnHand = (itemId, val) => {
        const updated = { ...onHand, [itemId]: Math.max(0, val) };
        setOnHand(updated);
        savePrep(updated, null, null, null);
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
        setOnHand({});
        setDoneItems({});
        setPrepMeta({});
        await savePrep({}, {}, {}, null);
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

    // Print cart
    const printCart = () => {
        const ingredients = getCartIngredients();
        const now = new Date();
        const dateStr = now.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
        const timeStr = now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
        // Group by category
        const byCat = {};
        ingredients.forEach(ing => {
            const cat = ing.catName || "Other";
            if (!byCat[cat]) byCat[cat] = [];
            byCat[cat].push(ing);
        });
        let html = `<html><head><title>DD Mau Prep Ingredients - ${dateStr}</title><style>
            body{font-family:Arial,sans-serif;max-width:800px;margin:0 auto;padding:20px;color:#333}
            h1{font-size:20px;color:#7c3aed;margin-bottom:4px}
            .date{font-size:12px;color:#888;margin-bottom:16px}
            .cat{background:#7c3aed;color:white;padding:8px 12px;font-weight:bold;font-size:14px;margin-top:16px;border-radius:6px 6px 0 0}
            table{width:100%;border-collapse:collapse;margin-bottom:12px}
            th{background:#ede9fe;padding:6px 10px;text-align:left;font-size:11px;color:#7c3aed;border:1px solid #ccc}
            td{padding:6px 10px;font-size:12px;border:1px solid #e0e0e0}
            tr:nth-child(even){background:#f9f9f9}
            .used{font-size:10px;color:#888}
            .no-print{margin:20px 0;text-align:center}
            .no-print button{padding:12px 24px;font-size:16px;font-weight:bold;border:none;border-radius:8px;cursor:pointer;margin:0 6px}
            .btn-print{background:#7c3aed;color:white} .btn-close{background:#e5e7eb;color:#555}
            @media print{.no-print{display:none !important}}
        </style></head><body>`;
        html += `<h1>DD Mau Prep Ingredients</h1><div class="date">${dateStr} at ${timeStr} - ${storeLocation} - ${busyMode ? "BUSY" : "SLOW"} day</div>`;
        Object.keys(byCat).sort().forEach(cat => {
            html += `<div class="cat">${cat} (${byCat[cat].length})</div>`;
            html += `<table><tr><th>Ingredient</th><th>Used By</th><th style="width:30px">\u2713</th></tr>`;
            byCat[cat].sort((a, b) => a.name.localeCompare(b.name)).forEach(ing => {
                html += `<tr><td>${ing.name}</td><td class="used">${ing.usedBy.join(", ")}</td><td></td></tr>`;
            });
            html += `</table>`;
        });
        html += `<div class="no-print"><button class="btn-print" onclick="window.print()">\u{1F5A8}\u{FE0F} Print Again</button><button class="btn-close" onclick="window.close()">\u{2715} Close</button></div>`;
        html += `</body></html>`;
        const w = window.open("", "_blank");
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
                    <span className="text-lg">{"\u{1F9EA}"}</span>
                    <div>
                        <span className="font-bold text-sm">{cartIngredients.length} {language === "es" ? "ingredientes necesarios" : "ingredients needed"}</span>
                        <span className="text-purple-200 text-xs ml-2">{totalDone}/{totalItems} {language === "es" ? "listos" : "done"}</span>
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

            {/* Cart Modal */}
            {showCart && (
                <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-end sm:items-center justify-center" onClick={() => setShowCart(false)}>
                    <div className="bg-white w-full max-w-lg max-h-[85vh] rounded-t-2xl sm:rounded-2xl overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}>
                        <div className="bg-purple-700 text-white px-4 py-3 flex items-center justify-between flex-shrink-0">
                            <h3 className="font-bold text-lg">{"\u{1F9EA}"} {language === "es" ? "Ingredientes Necesarios" : "Ingredients Needed"} ({cartIngredients.length})</h3>
                            <button onClick={() => setShowCart(false)} className="w-8 h-8 rounded-full bg-white bg-opacity-20 flex items-center justify-center text-white font-bold">{"\u{2715}"}</button>
                        </div>
                        <div className="flex-1 overflow-y-auto">
                            {cartIngredients.length === 0 ? (
                                <div className="p-8 text-center text-gray-400">{language === "es" ? "No se necesitan ingredientes" : "No ingredients needed - all prepped!"}</div>
                            ) : (
                                (() => {
                                    const byCat = {};
                                    cartIngredients.forEach(ing => {
                                        const cat = ing.catName || "Other";
                                        if (!byCat[cat]) byCat[cat] = [];
                                        byCat[cat].push(ing);
                                    });
                                    return Object.entries(byCat).sort(([a], [b]) => a.localeCompare(b)).map(([cat, items]) => (
                                        <div key={cat}>
                                            <div className="bg-purple-600 text-white px-4 py-2 font-bold text-sm">{cat} ({items.length})</div>
                                            <div className="divide-y divide-gray-100">
                                                {items.sort((a, b) => a.name.localeCompare(b.name)).map(ing => (
                                                    <div key={ing.id} className="px-4 py-2">
                                                        <div className="text-sm text-gray-800 font-medium">{language === "es" && ing.nameEs ? ing.nameEs : ing.name}</div>
                                                        <div className="text-xs text-gray-400 mt-0.5">{language === "es" ? "Usado en" : "Used by"}: {ing.usedBy.join(", ")}</div>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    ));
                                })()
                            )}
                        </div>
                        <div className="border-t border-gray-200 p-3 flex gap-2 flex-shrink-0 bg-gray-50">
                            <button onClick={printCart} className="flex-1 py-3 bg-purple-600 text-white rounded-xl font-bold text-sm hover:bg-purple-700 active:scale-95 transition">
                                {"\u{1F5A8}\u{FE0F}"} {language === "es" ? "Imprimir" : "Print"}
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
                                                            {prepMeta[item.id] && isDone && (
                                                                <span className="text-xs text-green-600">{"\u{2713}"} {prepMeta[item.id].by} {"\u{2014}"} {prepMeta[item.id].at}</span>
                                                            )}
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
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
}
