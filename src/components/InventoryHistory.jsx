import { useState, useEffect } from 'react';
import { db } from '../firebase';
import { doc, getDoc, setDoc, collection, getDocs } from 'firebase/firestore';
import { t } from '../data/translations';
import { toast } from '../toast';
import { escapeHtml as esc } from '../data/htmlEscape';

export default function InventoryHistory({ language, customInventory: customInventoryProp, storeLocation }) {
            const [historyDates, setHistoryDates] = useState([]);
            const [selectedDate, setSelectedDate] = useState(null);
            const [dayData, setDayData] = useState(null);
            const [prevData, setPrevData] = useState(null);
            const [loading, setLoading] = useState(true);
            // Editable list name
            const [listName, setListName] = useState("");
            const [editingName, setEditingName] = useState(false);
            // Ordered checkboxes
            const [ordered, setOrdered] = useState({});
            // Edit mode for counts & adding items
            const [histEditMode, setHistEditMode] = useState(false);
            const [histCounts, setHistCounts] = useState({});
            const [saving, setSaving] = useState(false);
            // Searchable add-item picker
            const [showAddPicker, setShowAddPicker] = useState(false);
            const [addSearch, setAddSearch] = useState("");
            // Full inventory (passed as prop or loaded from Firestore)
            const [fullInventory, setFullInventory] = useState(customInventoryProp || []);

            // Load full inventory if not passed as prop
            useEffect(() => {
                if (customInventoryProp && customInventoryProp.length > 0) {
                    setFullInventory(customInventoryProp);
                } else {
                    const loadInv = async () => {
                        try {
                            const docRef = doc(db, "ops", "inventory_" + storeLocation); const docSnapshot = await getDoc(docRef);
                            if (docSnapshot.exists() && docSnapshot.data().customInventory) setFullInventory(docSnapshot.data().customInventory);
                        } catch (err) { console.error("Error loading inventory for picker:", err); }
                    };
                    loadInv();
                }
            }, [customInventoryProp, storeLocation]);

            useEffect(() => {
                const fetchHistory = async () => {
                    try {
                        const colRef = collection(db, "inventoryHistory_" + storeLocation); const snapshot = await getDocs(colRef);
                        const dates = snapshot.docs.map(doc => doc.id).sort().reverse().slice(0, 30);
                        setHistoryDates(dates);
                        if (dates.length > 0) setSelectedDate(dates[0]);
                    } catch (err) { console.error("Error loading inventory history:", err); }
                    setLoading(false);
                };
                fetchHistory();
            }, [storeLocation]);

            // Load selected day + previous day for comparison
            useEffect(() => {
                if (!selectedDate) return;
                const fetchDay = async () => {
                    try {
                        const docRef = doc(db, "inventoryHistory_" + storeLocation, selectedDate);
                        const docSnap = await getDoc(docRef);
                        if (docSnap.exists()) {
                            const data = docSnap.data();
                            setDayData(data);
                            setListName(data.listName || "");
                            setOrdered(data.ordered || {});
                            setHistCounts(data.counts || {});
                        } else {
                            setDayData(null);
                            setListName("");
                            setOrdered({});
                            setHistCounts({});
                        }

                        // Find previous day in history
                        const idx = historyDates.indexOf(selectedDate);
                        if (idx < historyDates.length - 1) {
                            const prevDocRef = doc(db, "inventoryHistory_" + storeLocation, historyDates[idx + 1]);
                            const prevDocSnap = await getDoc(prevDocRef);
                            if (prevDocSnap.exists()) setPrevData(prevDocSnap.data());
                            else setPrevData(null);
                        } else {
                            setPrevData(null);
                        }
                    } catch (err) { console.error("Error loading day:", err); }
                    setHistEditMode(false);
                    setShowAddPicker(false);
                };
                fetchDay();
            }, [selectedDate, historyDates, storeLocation]);

            // Save helper — persist changes back to Firestore (merge to handle new fields)
            const saveToFirestore = async (updates) => {
                if (!selectedDate) return;
                setSaving(true);
                try {
                    const docRef = doc(db, "inventoryHistory_" + storeLocation, selectedDate);
                    await setDoc(docRef, updates, { merge: true });
                } catch (err) { console.error("Error saving inventory history:", err); }
                setSaving(false);
            };

            // Toggle ordered checkbox
            const toggleOrdered = async (itemId) => {
                const newOrdered = { ...ordered, [itemId]: !ordered[itemId] };
                setOrdered(newOrdered);
                await saveToFirestore({ ordered: newOrdered });
            };

            // Save list name
            const saveListName = async () => {
                setEditingName(false);
                await saveToFirestore({ listName });
            };

            // Update a count in edit mode
            const updateHistCount = (itemId, val) => {
                const n = Math.max(0, parseInt(val) || 0);
                setHistCounts(prev => ({ ...prev, [itemId]: n }));
            };

            // Save edited counts back (keep all items — this is a saved order list)
            const saveHistEdits = async () => {
                const updates = { counts: { ...histCounts } };
                await saveToFirestore(updates);
                setDayData(prev => ({ ...prev, counts: { ...histCounts } }));
                setHistEditMode(false);
            };

            // Get display vendor for an item (prefer vendor, fall back to supplier for old data)
            const getItemVendor = (item) => item.preferredVendor || item.vendor || item.supplier || "";

            // Add item from inventory picker to the saved list
            const addItemFromPicker = async (item, categoryName) => {
                if (!dayData) {
                    console.warn("addItemFromPicker called with no dayData loaded");
                    return;
                }
                // Check if item already exists in the saved list
                const alreadyExists = (dayData.items || []).some(cat => cat.items.some(i => i.id === item.id));
                if (alreadyExists) {
                    // Just increment count
                    const newCounts = { ...histCounts, [item.id]: (histCounts[item.id] || 0) + 1 };
                    setHistCounts(newCounts);
                    setDayData(prev => ({ ...prev, counts: newCounts }));
                    await saveToFirestore({ counts: newCounts });
                    return;
                }
                // Find or create category in saved list — include new fields
                const newItem = {
                    id: item.id,
                    name: item.name,
                    nameEs: item.nameEs || "",
                    vendor: item.vendor || "",
                    supplier: item.vendor || item.supplier || "",
                    pack: item.pack || "",
                    price: item.price || null,
                    preferredVendor: item.preferredVendor || item.vendor || "",
                    subcat: item.subcat || "",
                    orderDay: item.orderDay || ""
                };
                let updatedItems = [...(dayData.items || [])];
                const catIdx = updatedItems.findIndex(c => c.category === categoryName);
                if (catIdx >= 0) {
                    updatedItems[catIdx] = { ...updatedItems[catIdx], items: [...updatedItems[catIdx].items, newItem] };
                } else {
                    updatedItems.push({ category: categoryName, items: [newItem] });
                }
                const newCounts = { ...histCounts, [item.id]: 1 };
                setHistCounts(newCounts);
                setDayData(prev => ({ ...prev, items: updatedItems, counts: newCounts }));
                await saveToFirestore({ items: updatedItems, counts: newCounts });
            };

            const formatDate = (dateStr) => {
                // Keys are like "2026-04-11_143022"
                const datePart = dateStr.split("_")[0];
                const timePart = dateStr.split("_")[1];
                const d = new Date(datePart + "T12:00:00");
                const dateLabel = d.toLocaleDateString(language === "es" ? "es-US" : "en-US", { weekday: "short", month: "short", day: "numeric" });
                if (timePart) {
                    const h = timePart.slice(0, 2);
                    const m = timePart.slice(2, 4);
                    const hr = parseInt(h);
                    const ampm = hr >= 12 ? "pm" : "am";
                    const hr12 = hr % 12 || 12;
                    return `${dateLabel} ${hr12}:${m}${ampm}`;
                }
                return dateLabel;
            };

            const printInventory = () => {
                if (!dayData || !dayData.items) return;
                const dateLabel = formatDate(selectedDate);
                const titleName = listName || (language === "es" ? "Conteo de Inventario" : "Inventory Count");

                // Group items by preferred vendor for the print view
                const vendorGroups = {};
                dayData.items.forEach(cat => {
                    cat.items.forEach(item => {
                        const count = dayData.counts?.[item.id] || 0;
                        if (count > 0) {
                            const v = getItemVendor(item) || "Other";
                            if (!vendorGroups[v]) vendorGroups[v] = [];
                            vendorGroups[v].push({ ...item, count, categoryName: cat.category });
                        }
                    });
                });
                const vendors = Object.keys(vendorGroups).sort();

                let html = `<!DOCTYPE html><html><head><title>DD Mau - ${titleName}</title>
                    <style>
                        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 20px; color: #222; max-width: 800px; margin: 0 auto; }
                        h1 { font-size: 20px; margin-bottom: 4px; color: #2F5496; }
                        .subtitle { font-size: 12px; color: #666; margin-bottom: 16px; }
                        .vendor-header { background: #2F5496; color: white; padding: 8px 12px; font-weight: bold; font-size: 14px; margin-top: 16px; border-radius: 6px 6px 0 0; }
                        table { width: 100%; border-collapse: collapse; margin-bottom: 12px; }
                        th { background: #D6E4F0; text-align: left; padding: 6px 10px; font-size: 11px; color: #2F5496; border: 1px solid #ccc; }
                        td { padding: 5px 10px; font-size: 12px; border: 1px solid #ddd; }
                        tr:nth-child(even) { background: #f9f9f9; }
                        .count { text-align: center; font-weight: bold; font-size: 14px; width: 50px; }
                        .pack { color: #666; font-size: 11px; }
                        .cat-label { color: #999; font-size: 10px; }
                        .ordered { text-decoration: line-through; color: #999; }
                        .check { color: green; font-weight: bold; }
                        .no-print { position:sticky;top:0;z-index:1000;background:#2F5496;padding:10px;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.3) }
                        .no-print button { padding: 12px 24px; font-size: 16px; font-weight: bold; border: none; border-radius: 8px; cursor: pointer; margin: 0 6px; }
                        .btn-print { background: white; color: #2F5496; } .btn-close { background: #ff4444; color: white; }
                        @media print { body { padding: 10px; } h1 { font-size: 16px; } .no-print { display: none !important; } }
                    </style></head><body>`;
                html += `<div class="no-print"><button class="btn-close" onclick="try{window.close()}catch(e){} setTimeout(function(){if(!window.closed){window.location.href='https://ddmauapp.github.io/dd-mau-portal/'}},300)">✕ Close</button><button class="btn-print" onclick="window.print()">🖨️ Print</button></div>`;
                html += `<h1>🍜 DD Mau — ${esc(titleName)}</h1>`;
                html += `<div class="subtitle">${esc(dateLabel)} • ${language === "es" ? "Última actualización" : "Last updated"}: ${esc(new Date(dayData.date).toLocaleString())}</div>`;

                // FIX (review 2026-05-14, real): escape every item/category/
                // vendor name before interpolating into the print HTML.
                // Staff create custom items + categories so these are
                // attacker-controlled. Numeric `count` fields are passed
                // through directly — they're numbers, not strings.
                if (vendors.length > 0) {
                    // Print grouped by vendor (matching Operations print style)
                    vendors.forEach(v => {
                        const items = vendorGroups[v].sort((a, b) => a.name.localeCompare(b.name));
                        html += `<div class="vendor-header">${esc(v)} (${items.length} items)</div>`;
                        html += `<table><tr><th>Item</th><th style="width:50px">Qty</th><th>Pack</th><th style="width:30px">✓</th></tr>`;
                        items.forEach(item => {
                            const name = language === "es" && item.nameEs ? item.nameEs : item.name;
                            const isOrdered = ordered[item.id];
                            html += `<tr><td class="${isOrdered ? 'ordered' : ''}">${esc(name)} <span class="cat-label">${esc(item.categoryName || "")}</span></td><td class="count">${item.count}</td><td class="pack">${esc(item.pack || "")}</td><td>${isOrdered ? '<span class="check">✓</span>' : '☐'}</td></tr>`;
                        });
                        html += `</table>`;
                    });
                } else {
                    // Fallback: print by category if nothing counted
                    dayData.items.forEach(cat => {
                        html += `<table><tr><th colspan="4">${esc(cat.category)}</th></tr>`;
                        cat.items.forEach(item => {
                            const count = dayData.counts?.[item.id] || 0;
                            const name = language === "es" && item.nameEs ? item.nameEs : item.name;
                            const vendorStr = getItemVendor(item);
                            const vendorLabel = vendorStr ? ` <span class="cat-label">(${esc(vendorStr)})</span>` : "";
                            const isOrdered = ordered[item.id];
                            html += `<tr><td style="width:30px">${isOrdered ? '<span class="check">✓</span>' : '☐'}</td><td class="${isOrdered ? 'ordered' : ''}">${esc(name)}${vendorLabel}</td><td class="count">${count}</td><td class="pack">${esc(item.pack || "")}</td></tr>`;
                        });
                        html += `</table>`;
                    });
                }

                // buttons are in sticky top bar
                html += `</body></html>`;
                const win = window.open("", "_blank");
                if (!win) {
                    toast(language === "es" ? "Por favor permita ventanas emergentes para imprimir." : "Please allow pop-ups to print.");
                    return;
                }
                win.document.write(html);
                win.document.close();
                win.focus();
                setTimeout(() => win.print(), 300);
            };

            if (loading) return <div className="text-center text-gray-500 py-4">{language === "es" ? "Cargando..." : "Loading..."}</div>;

            if (historyDates.length === 0) {
                return (
                    <div className="bg-gray-50 rounded-lg p-4 text-center text-gray-500">
                        <p className="text-sm">{language === "es"
                            ? "Aún no hay historial de inventario. Comenzará a guardarse cuando se actualicen los conteos."
                            : "No inventory history yet. It will start saving when counts are updated."}</p>
                    </div>
                );
            }

            // Count ordered vs total
            const totalItems = dayData?.items?.reduce((sum, cat) => sum + cat.items.length, 0) || 0;
            const orderedCount = dayData?.items?.reduce((sum, cat) => sum + cat.items.filter(i => ordered[i.id]).length, 0) || 0;

            return (
                <div>
                    <div className="flex gap-2 overflow-x-auto pb-2 mb-4" style={{ scrollbarWidth: "none" }}>
                        {historyDates.map(date => (
                            <button key={date} onClick={() => setSelectedDate(date)}
                                className={`flex-shrink-0 px-3 py-2 rounded-lg text-xs font-bold transition ${selectedDate === date
                                    ? "bg-mint-700 text-white"
                                    : "bg-gray-100 text-gray-600 hover:bg-mint-50"}`}>
                                {formatDate(date)}
                            </button>
                        ))}
                    </div>

                    {selectedDate && dayData && dayData.items && (
                        <div className="space-y-4">
                            {/* Date + editable list name */}
                            <div className="bg-white rounded-xl border-2 border-mint-200 p-3">
                                <p className="text-xs text-gray-500 mb-1">
                                    {formatDate(selectedDate)}
                                </p>
                                {editingName ? (
                                    <div className="flex gap-2">
                                        <input type="text" value={listName}
                                            onChange={e => setListName(e.target.value)}
                                            placeholder={language === "es" ? "Nombre de la lista..." : "List name..."}
                                            className="flex-1 px-3 py-1.5 border-2 border-mint-300 rounded-lg text-sm font-bold focus:outline-none focus:border-mint-700"
                                            autoFocus
                                            onKeyDown={e => { if (e.key === "Enter") saveListName(); }} />
                                        <button onClick={saveListName}
                                            className="px-3 py-1.5 bg-mint-700 text-white rounded-lg text-xs font-bold hover:bg-mint-800">
                                            ✓
                                        </button>
                                    </div>
                                ) : (
                                    <div className="flex items-center gap-2 cursor-pointer group" onClick={() => setEditingName(true)}>
                                        <h4 className="font-bold text-lg text-gray-800">
                                            {listName || (language === "es" ? "Conteo de Inventario" : "Inventory Count")}
                                        </h4>
                                        <span className="text-gray-400 group-hover:text-mint-700 text-sm">✏️</span>
                                    </div>
                                )}
                                {/* Order progress */}
                                {totalItems > 0 && (
                                    <div className="mt-2">
                                        <div className="flex justify-between text-xs mb-1">
                                            <span className="text-gray-500">{language === "es" ? "Progreso de pedido" : "Order progress"}</span>
                                            <span className="font-bold text-mint-700">{orderedCount}/{totalItems}</span>
                                        </div>
                                        <div className="w-full bg-gray-200 rounded-full h-2">
                                            <div className="bg-mint-500 h-2 rounded-full transition-all" style={{ width: `${totalItems > 0 ? (orderedCount / totalItems * 100) : 0}%` }}></div>
                                        </div>
                                    </div>
                                )}
                            </div>

                            {/* Action buttons */}
                            <div className="flex gap-2">
                                <button onClick={() => { if (histEditMode) { saveHistEdits(); } else { setHistEditMode(true); } setShowAddPicker(false); }}
                                    className={`flex-1 py-2 rounded-lg text-xs font-bold transition ${histEditMode ? "bg-green-700 text-white" : "bg-blue-700 text-white"}`}>
                                    {histEditMode
                                        ? (language === "es" ? "✓ Guardar" : "✓ Save")
                                        : (language === "es" ? "✏️ Editar Lista" : "✏️ Edit List")}
                                </button>
                                <button onClick={printInventory}
                                    className="px-4 py-2 bg-mint-100 text-mint-700 rounded-lg text-xs font-bold hover:bg-mint-200 transition">
                                    🖨️ {language === "es" ? "Imprimir" : "Print"}
                                </button>
                            </div>

                            {/* Items list */}
                            {dayData.items.map((cat, catIdx) => (
                                <div key={catIdx} className="bg-white rounded-lg border border-gray-200 overflow-hidden">
                                    <div className="p-2 bg-mint-50 border-b border-gray-200 flex justify-between items-center">
                                        <h4 className="font-bold text-sm text-mint-800">{cat.category}</h4>
                                        <span className="text-xs text-gray-400">
                                            {cat.items.filter(i => ordered[i.id]).length}/{cat.items.length} {language === "es" ? "pedido" : "ordered"}
                                        </span>
                                    </div>
                                    <div className="divide-y divide-gray-100">
                                        {cat.items.map((item, idx) => {
                                            const count = histEditMode ? (histCounts[item.id] || 0) : (dayData.counts?.[item.id] || 0);
                                            const prevCount = prevData?.counts?.[item.id];
                                            const diff = prevCount !== undefined ? (dayData.counts?.[item.id] || 0) - prevCount : null;
                                            const isOrdered = ordered[item.id];
                                            const vendorLabel = getItemVendor(item);

                                            return (
                                                <div key={idx} className={`flex items-center gap-2 px-2 py-2 text-sm ${isOrdered && !histEditMode ? "bg-green-50" : ""}`}>
                                                    {/* Checkbox */}
                                                    {!histEditMode && (
                                                        <button onClick={() => toggleOrdered(item.id)}
                                                            className={`w-6 h-6 rounded border-2 flex items-center justify-center flex-shrink-0 transition ${
                                                                isOrdered ? "bg-green-500 border-green-500 text-white" : "border-gray-300 hover:border-mint-500"}`}>
                                                            {isOrdered && <span className="text-xs font-bold">✓</span>}
                                                        </button>
                                                    )}
                                                    <div className={`flex-1 min-w-0 ${isOrdered && !histEditMode ? "line-through text-gray-400" : ""}`}>
                                                        <span className="text-gray-800">{language === "es" && item.nameEs ? item.nameEs : item.name}</span>
                                                        {vendorLabel && <span className="text-xs text-gray-400 ml-1">({vendorLabel})</span>}
                                                        {item.pack && <span className="text-xs text-blue-400 ml-1">{item.pack}</span>}
                                                    </div>
                                                    <div className="flex items-center gap-2 flex-shrink-0">
                                                        {histEditMode ? (
                                                            <div className="flex items-center gap-1">
                                                                <button onClick={() => updateHistCount(item.id, (histCounts[item.id] || 0) - 1)}
                                                                    className="w-7 h-7 rounded bg-gray-200 text-gray-700 font-bold flex items-center justify-center hover:bg-red-100">−</button>
                                                                <span className="w-8 text-center font-bold">{histCounts[item.id] || 0}</span>
                                                                <button onClick={() => updateHistCount(item.id, (histCounts[item.id] || 0) + 1)}
                                                                    className="w-7 h-7 rounded bg-gray-200 text-gray-700 font-bold flex items-center justify-center hover:bg-green-100">+</button>
                                                            </div>
                                                        ) : (
                                                            <>
                                                                <span className="font-bold text-gray-800 w-8 text-right">{count}</span>
                                                                {diff !== null && diff !== 0 && (
                                                                    <span className={`text-xs font-bold px-1.5 py-0.5 rounded ${diff > 0 ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}`}>
                                                                        {diff > 0 ? "+" : ""}{diff}
                                                                    </span>
                                                                )}
                                                            </>
                                                        )}
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            ))}

                            {/* Add item from inventory picker */}
                            {histEditMode && !showAddPicker && (
                                <button onClick={() => { setShowAddPicker(true); setAddSearch(""); }}
                                    className="w-full py-3 rounded-xl font-bold text-sm bg-blue-600 text-white hover:bg-blue-700 active:scale-95 transition">
                                    + {language === "es" ? "Agregar Artículo del Inventario" : "Add Item from Inventory"}
                                </button>
                            )}
                            {histEditMode && showAddPicker && (
                                <div className="bg-white border-2 border-blue-300 rounded-xl overflow-hidden shadow-lg">
                                    <div className="p-3 bg-blue-50 border-b border-blue-200 flex items-center gap-2">
                                        <input type="text" value={addSearch} onChange={e => setAddSearch(e.target.value)}
                                            placeholder={language === "es" ? "🔍 Buscar artículo para agregar..." : "🔍 Search item to add..."}
                                            className="flex-1 px-3 py-2 border-2 border-gray-200 rounded-lg text-sm focus:outline-none focus:border-blue-500"
                                            autoFocus />
                                        <button onClick={() => setShowAddPicker(false)}
                                            className="px-3 py-2 bg-gray-200 text-gray-600 rounded-lg text-sm font-bold hover:bg-gray-300">✕</button>
                                    </div>
                                    <div className="max-h-64 overflow-y-auto">
                                        {(() => {
                                            const searchLower = addSearch.toLowerCase().trim();
                                            const existingIds = new Set((dayData.items || []).flatMap(cat => cat.items.map(i => i.id)));
                                            let hasResults = false;
                                            return fullInventory.map((cat, ci) => {
                                                const catName = cat.category || cat.name || "";
                                                const matchingItems = cat.items.filter(item => {
                                                    if (!searchLower) return !existingIds.has(item.id);
                                                    const nameMatch = (item.name || "").toLowerCase().includes(searchLower);
                                                    const nameEsMatch = (item.nameEs || "").toLowerCase().includes(searchLower);
                                                    const vendorMatch = (item.vendor || "").toLowerCase().includes(searchLower);
                                                    const supplierMatch = (item.supplier || "").toLowerCase().includes(searchLower);
                                                    const preferredMatch = (item.preferredVendor || "").toLowerCase().includes(searchLower);
                                                    return (nameMatch || nameEsMatch || vendorMatch || supplierMatch || preferredMatch);
                                                });
                                                if (matchingItems.length === 0) return null;
                                                hasResults = true;
                                                return (
                                                    <div key={ci}>
                                                        <div className="px-3 py-1.5 bg-gray-50 border-b text-xs font-bold text-gray-500 uppercase">{catName}</div>
                                                        {matchingItems.map(item => {
                                                            const alreadyIn = existingIds.has(item.id);
                                                            const itemVendor = item.preferredVendor || item.vendor || item.supplier || "";
                                                            return (
                                                                <button key={item.id}
                                                                    onClick={() => { addItemFromPicker(item, catName); }}
                                                                    className={`w-full text-left px-3 py-2.5 border-b border-gray-100 flex items-center justify-between hover:bg-blue-50 transition ${alreadyIn ? "bg-green-50" : ""}`}>
                                                                    <div>
                                                                        <span className="text-sm text-gray-800 font-medium">{language === "es" && item.nameEs ? item.nameEs : item.name}</span>
                                                                        {itemVendor && <span className="text-xs text-gray-400 ml-2">({itemVendor})</span>}
                                                                        {item.pack && <span className="text-xs text-blue-400 ml-1">{item.pack}</span>}
                                                                    </div>
                                                                    <span className="text-xs font-bold text-blue-600">
                                                                        {alreadyIn
                                                                            ? (language === "es" ? "+1 más" : "+1 more")
                                                                            : (language === "es" ? "+ Agregar" : "+ Add")}
                                                                    </span>
                                                                </button>
                                                            );
                                                        })}
                                                    </div>
                                                );
                                            });
                                        })()}
                                        {addSearch && fullInventory.every(cat => {
                                            const s = addSearch.toLowerCase().trim();
                                            return cat.items.every(item =>
                                                !(item.name || "").toLowerCase().includes(s) &&
                                                !(item.nameEs || "").toLowerCase().includes(s) &&
                                                !(item.vendor || "").toLowerCase().includes(s) &&
                                                !(item.supplier || "").toLowerCase().includes(s) &&
                                                !(item.preferredVendor || "").toLowerCase().includes(s)
                                            );
                                        }) && (
                                            <div className="p-4 text-center text-gray-400 text-sm">
                                                {language === "es" ? "No se encontraron artículos" : "No items found"}
                                            </div>
                                        )}
                                    </div>
                                </div>
                            )}

                            {/* Save edits button */}
                            {histEditMode && (
                                <button onClick={saveHistEdits} disabled={saving}
                                    className="w-full py-3 rounded-xl font-bold text-sm bg-mint-700 text-white hover:bg-mint-800 active:scale-95 transition disabled:opacity-50">
                                    {saving
                                        ? (language === "es" ? "Guardando..." : "Saving...")
                                        : (language === "es" ? "💾 Guardar Cambios" : "💾 Save Changes")}
                                </button>
                            )}
                        </div>
                    )}

                    {selectedDate && !dayData && (
                        <p className="text-center text-gray-400 text-sm py-4">{language === "es" ? "Sin datos para este día" : "No data for this day"}</p>
                    )}
                </div>
            );
        }
