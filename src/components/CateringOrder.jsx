import { useState, useEffect } from 'react';
import { db } from '../firebase';
import { doc, onSnapshot, setDoc, collection, query, orderBy, limit, addDoc } from 'firebase/firestore';
import { t } from '../data/translations';
import { CATERING_MENU, ALL_SAUCES, ALL_SAUCES_ES, ALL_PROTEINS, ALL_PROTEINS_ES, BASE_OPTIONS, BASE_OPTIONS_ES } from '../data/catering';
import ToastInvoices from './ToastInvoices';
// CateringMenuItem sub-component
function CateringMenuItem({ item, language, onAdd }) {
            const [open, setOpen] = useState(false);
            const [sizeIdx, setSizeIdx] = useState(0);
            const [selectedSauces, setSelectedSauces] = useState([]);
            const [sauceCounts, setSauceCounts] = useState({});
            const [selectedProteins, setSelectedProteins] = useState([]);
            const [proteinCounts, setProteinCounts] = useState({});
            const [singleProtein, setSingleProtein] = useState("");
            const [selectedBase, setSelectedBase] = useState("");
            const [selectedType, setSelectedType] = useState("");
            const [selectedSingleSauce, setSelectedSingleSauce] = useState("");
            const [samplerProteins, setSamplerProteins] = useState(item.samplerPicks ? item.samplerPicks.map(() => []) : []);
            const [samplerEggRoll, setSamplerEggRoll] = useState("");
            const [qty, setQty] = useState(1);
            const [itemNote, setItemNote] = useState("");
            const [addError, setAddError] = useState("");
            const size = item.sizes[sizeIdx];
            const maxSauces = size.sauceCount || item.sauceCount || 0;
            const maxProteins = size.proteinCount || 0;
            const totalPcs = item.hasProteins ? (parseInt(size.label) || 0) : 0;
            const toggleSauce = (s) => {
                if (selectedSauces.includes(s)) {
                    const newList = selectedSauces.filter(x => x !== s);
                    setSelectedSauces(newList);
                    setSauceCounts(prev => {
                        const updated = { ...prev };
                        delete updated[s];
                        if (newList.length > 0 && maxSauces > 0) {
                            const each = Math.floor(maxSauces / newList.length);
                            const remainder = maxSauces % newList.length;
                            newList.forEach((sc, i) => { updated[sc] = each + (i < remainder ? 1 : 0); });
                        }
                        return updated;
                    });
                } else {
                    const newList = [...selectedSauces, s];
                    setSelectedSauces(newList);
                    setSauceCounts(() => {
                        const updated = {};
                        const each = Math.floor(maxSauces / newList.length);
                        const remainder = maxSauces % newList.length;
                        newList.forEach((sc, i) => { updated[sc] = each + (i < remainder ? 1 : 0); });
                        return updated;
                    });
                }
            };
            const adjustSauceCount = (s, delta) => {
                setSauceCounts(prev => ({ ...prev, [s]: Math.max(0, (prev[s] || 0) + delta) }));
            };
            const setSauceCountDirect = (s, val) => {
                const num = parseInt(val);
                setSauceCounts(prev => ({ ...prev, [s]: isNaN(num) ? 0 : Math.max(0, num) }));
            };
            const sauceCountTotal = Object.values(sauceCounts).reduce((s, v) => s + v, 0);
            const toggleProtein = (p) => {
                if (selectedProteins.includes(p)) {
                    const newList = selectedProteins.filter(x => x !== p);
                    setSelectedProteins(newList);
                    setProteinCounts(prev => {
                        const updated = { ...prev };
                        delete updated[p];
                        if (newList.length > 0 && totalPcs > 0) {
                            const each = Math.floor(totalPcs / newList.length);
                            const remainder = totalPcs % newList.length;
                            newList.forEach((pr, i) => { updated[pr] = each + (i < remainder ? 1 : 0); });
                        }
                        return updated;
                    });
                } else {
                    const newList = [...selectedProteins, p];
                    setSelectedProteins(newList);
                    setProteinCounts(prev => {
                        const updated = {};
                        if (totalPcs > 0) {
                            const each = Math.floor(totalPcs / newList.length);
                            const remainder = totalPcs % newList.length;
                            newList.forEach((pr, i) => { updated[pr] = each + (i < remainder ? 1 : 0); });
                        } else {
                            newList.forEach(pr => { updated[pr] = prev[pr] || 0; });
                        }
                        return updated;
                    });
                }
            };
            const adjustProteinCount = (p, delta) => {
                setProteinCounts(prev => {
                    const newVal = Math.max(0, (prev[p] || 0) + delta);
                    return { ...prev, [p]: newVal };
                });
            };
            const setProteinCountDirect = (p, val) => {
                const num = parseInt(val);
                setProteinCounts(prev => ({ ...prev, [p]: isNaN(num) ? 0 : Math.max(0, num) }));
            };
            const proteinCountTotal = Object.values(proteinCounts).reduce((s, v) => s + v, 0);
            const toggleSamplerProtein = (groupIdx, p, max) => {
                setSamplerProteins(prev => {
                    const updated = prev.map(a => [...a]);
                    if (updated[groupIdx].includes(p)) updated[groupIdx] = updated[groupIdx].filter(x => x !== p);
                    else if (updated[groupIdx].length < max) updated[groupIdx] = [...updated[groupIdx], p];
                    return updated;
                });
            };
            const handleAdd = () => {
                if (item.typeOptions && !selectedType) {
                    setAddError(language === "es" ? "Elige un tipo" : "Choose a type");
                    return;
                }
                if (item.singleSauceOptions && !selectedSingleSauce) {
                    setAddError(language === "es" ? "Elige una salsa" : "Choose a sauce");
                    return;
                }
                if (item.hasSauces && maxSauces > 0) {
                    if (selectedSauces.length === 0) {
                        setAddError(language === "es" ? "Elige al menos una salsa" : "Choose at least one sauce");
                        return;
                    }
                    if (sauceCountTotal !== maxSauces) {
                        setAddError(language === "es" ? "Las porciones de salsa deben ser " + maxSauces + " (tienes " + sauceCountTotal + ")" : "Sauce portions must equal " + maxSauces + " (you have " + sauceCountTotal + ")");
                        return;
                    }
                }
                if (item.hasProteins && maxProteins > 0) {
                    if (selectedProteins.length === 0) {
                        setAddError(language === "es" ? "Elige al menos una proteína" : "Choose at least one protein");
                        return;
                    }
                    if (totalPcs > 0 && proteinCountTotal !== totalPcs) {
                        setAddError(language === "es" ? "El total de piezas debe ser " + totalPcs + " (tienes " + proteinCountTotal + ")" : "Piece count must equal " + totalPcs + " (you have " + proteinCountTotal + ")");
                        return;
                    }
                }
                if (item.proteinOptions && !singleProtein) {
                    setAddError(language === "es" ? "Elige una proteína" : "Choose a protein");
                    return;
                }
                if (item.hasBase && !selectedBase) {
                    setAddError(language === "es" ? "Elige una base" : "Choose a base");
                    return;
                }
                if (item.samplerPicks) {
                    for (let i = 0; i < item.samplerPicks.length; i++) {
                        if (samplerProteins[i].length < item.samplerPicks[i].count) {
                            const name = language === "es" ? item.samplerPicks[i].nameEs : item.samplerPicks[i].name;
                            setAddError(language === "es" ? `Elige ${item.samplerPicks[i].count} proteínas para ${name}` : `Choose ${item.samplerPicks[i].count} proteins for ${name}`);
                            return;
                        }
                    }
                }
                if (item.samplerEggRollType && !samplerEggRoll) {
                    setAddError(language === "es" ? "Elige tipo de rollo de huevo" : "Choose egg roll type");
                    return;
                }
                setAddError("");
                const allProteins = item.proteinOptions ? [singleProtein] : (item.hasProteins && totalPcs > 0 ? selectedProteins.map(p => p + " x" + (proteinCounts[p] || 0)) : selectedProteins);
                const allSauces = (item.hasSauces && maxSauces > 0) ? selectedSauces.map(s => s + (sauceCounts[s] > 1 ? " x" + sauceCounts[s] : "")) : selectedSauces;
                const extras = {};
                if (item.typeOptions) extras.type = selectedType;
                if (item.singleSauceOptions) extras.singleSauce = selectedSingleSauce;
                if (item.samplerPicks) extras.samplerProteins = samplerProteins;
                if (item.samplerEggRollType) extras.samplerEggRoll = samplerEggRoll;
                onAdd(item, sizeIdx, allSauces, allProteins, selectedBase, "", qty, itemNote, extras);
                setOpen(false); setSelectedSauces([]); setSauceCounts({}); setSelectedProteins([]); setProteinCounts({}); setSingleProtein("");
                setSelectedBase(""); setSelectedType(""); setSelectedSingleSauce("");
                setQty(1); setSizeIdx(0); setItemNote("");
                setSamplerProteins(item.samplerPicks ? item.samplerPicks.map(() => []) : []);
                setSamplerEggRoll("");
            };
            return (
                <div className="mb-3 bg-white border-2 border-gray-200 rounded-lg overflow-hidden">
                    <div className="p-3 cursor-pointer flex justify-between items-center" onClick={() => setOpen(!open)}>
                        <div>
                            <p className="font-bold text-sm text-gray-800">{language === "es" ? (item.nameEs || item.name) : item.name}</p>
                            <p className="text-xs text-gray-400">{item.sizes.map(s => `${s.label} — $${s.price}`).join(" | ")}</p>
                        </div>
                        <span className={`text-lg transition-transform ${open ? "rotate-45" : ""}`}>➕</span>
                    </div>
                    {open && (
                        <div className="border-t border-gray-200 p-3 bg-gray-50 space-y-3">
                            {/* Size */}
                            <div>
                                <p className="text-xs font-bold text-gray-600 mb-1">{language === "es" ? "Tamaño" : "Size"}</p>
                                <div className="flex flex-wrap gap-2">
                                    {item.sizes.map((s, i) => (
                                        <button key={i} onClick={() => { setSizeIdx(i); setSelectedSauces([]); setSauceCounts({}); setSelectedProteins([]); setProteinCounts({}); }}
                                            className={`px-3 py-2 rounded-lg text-xs font-bold border-2 transition ${sizeIdx === i ? "bg-mint-700 text-white border-mint-700" : "bg-white text-gray-600 border-gray-200"}`}>
                                            {s.label} — ${s.price}
                                        </button>
                                    ))}
                                </div>
                            </div>
                            {item.typeOptions && (
                                <div>
                                    <p className="text-xs font-bold text-gray-600 mb-1">🥚 {language === "es" ? "Elige Tipo" : "Choose Type"} *</p>
                                    <div className="flex flex-wrap gap-2">
                                        {item.typeOptions.map((t, i) => {
                                            const label = language === "es" ? (item.typeOptionsEs?.[i] || t) : t;
                                            return (
                                                <button key={t} onClick={() => setSelectedType(t)}
                                                    className={`px-3 py-1.5 rounded-full text-xs font-bold border-2 transition ${selectedType === t ? "bg-orange-500 text-white border-orange-500" : "bg-white text-gray-600 border-gray-200"}`}>
                                                    {label} {selectedType === t ? "✓" : ""}
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>
                            )}
                            {item.singleSauceOptions && (
                                <div>
                                    <p className="text-xs font-bold text-gray-600 mb-1">🥫 {language === "es" ? "Elige Salsa" : "Choose Sauce"} *</p>
                                    <div className="flex flex-wrap gap-2">
                                        {item.singleSauceOptions.map((s, i) => {
                                            const label = language === "es" ? (item.singleSauceOptionsEs?.[i] || s) : s;
                                            return (
                                                <button key={s} onClick={() => setSelectedSingleSauce(s)}
                                                    className={`px-3 py-1.5 rounded-full text-xs font-bold border-2 transition ${selectedSingleSauce === s ? "bg-red-500 text-white border-red-500" : "bg-white text-gray-600 border-gray-200"}`}>
                                                    {label} {selectedSingleSauce === s ? "✓" : ""}
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>
                            )}
                            {item.proteinOptions && (
                                <div>
                                    <p className="text-xs font-bold text-gray-600 mb-1">🍖 {language === "es" ? "Elige Proteína" : "Choose Protein"} *</p>
                                    <div className="flex flex-wrap gap-2">
                                        {item.proteinOptions.map((p, i) => {
                                            const label = language === "es" ? (item.proteinOptionsEs?.[i] || p) : p;
                                            return (
                                                <button key={p} onClick={() => setSingleProtein(p)}
                                                    className={`px-3 py-1.5 rounded-full text-xs font-bold border-2 transition ${singleProtein === p ? "bg-orange-500 text-white border-orange-500" : "bg-white text-gray-600 border-gray-200"}`}>
                                                    {label} {singleProtein === p ? "✓" : ""}
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>
                            )}
                            {item.hasProteins && maxProteins > 0 && (
                                <div>
                                    <p className="text-xs font-bold text-gray-600 mb-1">🍖 {language === "es" ? "Elige Proteínas" : "Choose Proteins"} {totalPcs > 0 ? `(${totalPcs} ${language === "es" ? "piezas total" : "pcs total"})` : ""} *</p>
                                    <div className="space-y-2">
                                        {ALL_PROTEINS.map((p, i) => {
                                            const label = language === "es" ? ALL_PROTEINS_ES[i] : p;
                                            const selected = selectedProteins.includes(p);
                                            const count = proteinCounts[p] || 0;
                                            return (
                                                <div key={p} className="flex items-center gap-2">
                                                    <button onClick={() => toggleProtein(p)}
                                                        className={`flex-1 px-3 py-2 rounded-lg text-xs font-bold border-2 transition text-left ${selected ? "bg-orange-500 text-white border-orange-500" : "bg-white text-gray-600 border-gray-200"}`}>
                                                        {label} {selected ? "✓" : ""}
                                                    </button>
                                                    {selected && (
                                                        <div className="flex items-center bg-white border-2 border-orange-300 rounded-lg overflow-hidden">
                                                            <button onClick={() => adjustProteinCount(p, -1)} className="px-2.5 py-1.5 text-orange-600 font-bold text-sm active:bg-orange-50">−</button>
                                                            <input value={count} onChange={e => setProteinCountDirect(p, e.target.value)}
                                                                type="number" min="0"
                                                                className="w-12 text-center text-sm font-bold border-x border-orange-200 py-1.5 appearance-none"
                                                                style={{MozAppearance: "textfield", WebkitAppearance: "none"}} />
                                                            <button onClick={() => adjustProteinCount(p, 1)} className="px-2.5 py-1.5 text-orange-600 font-bold text-sm active:bg-orange-50">+</button>
                                                        </div>
                                                    )}
                                                </div>
                                            );
                                        })}
                                    </div>
                                    <div className="flex justify-between items-center mt-2">
                                        <p className="text-xs text-gray-400">{selectedProteins.length} {language === "es" ? "proteínas seleccionadas" : "proteins selected"}</p>
                                        {totalPcs > 0 && (
                                            <p className={`text-xs font-bold ${proteinCountTotal === totalPcs ? "text-green-600" : proteinCountTotal > totalPcs ? "text-red-500" : "text-amber-500"}`}>
                                                {proteinCountTotal}/{totalPcs} {language === "es" ? "pzas" : "pcs"}
                                                {proteinCountTotal === totalPcs ? " ✓" : ""}
                                            </p>
                                        )}
                                    </div>
                                </div>
                            )}
                            {item.samplerPicks && item.samplerPicks.map((sp, gIdx) => (
                                <div key={gIdx} className="bg-white border border-gray-200 rounded-lg p-2">
                                    <p className="text-xs font-bold text-gray-700 mb-1">🍖 {language === "es" ? sp.nameEs : sp.name} — {language === "es" ? `Elige ${sp.count} Proteínas` : `Choose ${sp.count} Proteins`} *</p>
                                    <div className="flex flex-wrap gap-2">
                                        {ALL_PROTEINS.map((p, i) => {
                                            const label = language === "es" ? ALL_PROTEINS_ES[i] : p;
                                            const selected = samplerProteins[gIdx]?.includes(p);
                                            return (
                                                <button key={p} onClick={() => toggleSamplerProtein(gIdx, p, sp.count)}
                                                    className={`px-3 py-1.5 rounded-full text-xs font-bold border-2 transition ${selected ? "bg-orange-500 text-white border-orange-500" : "bg-white text-gray-600 border-gray-200"}`}>
                                                    {label} {selected ? "✓" : ""}
                                                </button>
                                            );
                                        })}
                                    </div>
                                    <p className="text-xs text-gray-400 mt-1">{samplerProteins[gIdx]?.length || 0}/{sp.count} {language === "es" ? "seleccionadas" : "selected"}</p>
                                </div>
                            ))}
                            {item.samplerEggRollType && (
                                <div className="bg-white border border-gray-200 rounded-lg p-2">
                                    <p className="text-xs font-bold text-gray-700 mb-1">🥚 {language === "es" ? "Rollos de Huevo (10 mitades) — Elige Tipo" : "Egg Rolls (10 halves) — Choose Type"} *</p>
                                    <div className="flex flex-wrap gap-2">
                                        {["Vietnamese", "Veggie"].map((t, i) => {
                                            const label = language === "es" ? ["Vietnamitas", "Vegetarianos"][i] : t;
                                            return (
                                                <button key={t} onClick={() => setSamplerEggRoll(t)}
                                                    className={`px-3 py-1.5 rounded-full text-xs font-bold border-2 transition ${samplerEggRoll === t ? "bg-orange-500 text-white border-orange-500" : "bg-white text-gray-600 border-gray-200"}`}>
                                                    {label} {samplerEggRoll === t ? "✓" : ""}
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>
                            )}
                            {item.hasBase && (
                                <div>
                                    <p className="text-xs font-bold text-gray-600 mb-1">🍜 {language === "es" ? "Elige Base" : "Choose Base"} *</p>
                                    <div className="flex flex-wrap gap-2">
                                        {BASE_OPTIONS.map((b, i) => (
                                            <button key={b} onClick={() => setSelectedBase(b)}
                                                className={`px-3 py-1.5 rounded-full text-xs font-bold border-2 transition ${selectedBase === b ? "bg-blue-500 text-white border-blue-500" : "bg-white text-gray-600 border-gray-200"}`}>
                                                {language === "es" ? BASE_OPTIONS_ES[i] : b} {selectedBase === b ? "✓" : ""}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            )}
                            {item.hasSauces && maxSauces > 0 && (
                                <div>
                                    <p className="text-xs font-bold text-gray-600 mb-1">🥫 {language === "es" ? "Elige Salsas" : "Choose Sauces"} ({maxSauces} {language === "es" ? "porciones total" : "portions total"}) *</p>
                                    <div className="space-y-2">
                                        {ALL_SAUCES.map((s, i) => {
                                            const label = language === "es" ? ALL_SAUCES_ES[i] : s;
                                            const selected = selectedSauces.includes(s);
                                            const count = sauceCounts[s] || 0;
                                            return (
                                                <div key={s} className="flex items-center gap-2">
                                                    <button onClick={() => toggleSauce(s)}
                                                        className={`flex-1 px-3 py-2 rounded-lg text-xs font-bold border-2 transition text-left ${selected ? "bg-red-500 text-white border-red-500" : "bg-white text-gray-600 border-gray-200"}`}>
                                                        {label} {selected ? "✓" : ""}
                                                    </button>
                                                    {selected && (
                                                        <div className="flex items-center bg-white border-2 border-red-300 rounded-lg overflow-hidden">
                                                            <button onClick={() => adjustSauceCount(s, -1)} className="px-2.5 py-1.5 text-red-600 font-bold text-sm active:bg-red-50">−</button>
                                                            <input value={count} onChange={e => setSauceCountDirect(s, e.target.value)}
                                                                type="number" min="0"
                                                                className="w-12 text-center text-sm font-bold border-x border-red-200 py-1.5 appearance-none"
                                                                style={{MozAppearance: "textfield", WebkitAppearance: "none"}} />
                                                            <button onClick={() => adjustSauceCount(s, 1)} className="px-2.5 py-1.5 text-red-600 font-bold text-sm active:bg-red-50">+</button>
                                                        </div>
                                                    )}
                                                </div>
                                            );
                                        })}
                                    </div>
                                    <div className="flex justify-between items-center mt-2">
                                        <p className="text-xs text-gray-400">{selectedSauces.length} {language === "es" ? "salsas seleccionadas" : "sauces selected"}</p>
                                        <p className={`text-xs font-bold ${sauceCountTotal === maxSauces ? "text-green-600" : sauceCountTotal > maxSauces ? "text-red-500" : "text-amber-500"}`}>
                                            {sauceCountTotal}/{maxSauces} {language === "es" ? "porciones" : "portions"}
                                            {sauceCountTotal === maxSauces ? " ✓" : ""}
                                        </p>
                                    </div>
                                </div>
                            )}
                            {item.note && (
                                <p className="text-xs text-gray-500 italic bg-amber-50 p-2 rounded-lg">ℹ️ {language === "es" ? (item.noteEs || item.note) : item.note}</p>
                            )}
                            <div>
                                <p className="text-xs font-bold text-gray-600 mb-1">📝 {language === "es" ? "Petición Especial para este Artículo" : "Special Request for this Item"}</p>
                                <input value={itemNote} onChange={e => setItemNote(e.target.value)}
                                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-xs" placeholder={language === "es" ? "Ej: sin cebolla, extra salsa..." : "e.g. no onions, extra sauce..."} />
                            </div>
                            <div className="flex items-center gap-3">
                                <div className="flex items-center border-2 border-gray-200 rounded-lg">
                                    <button onClick={() => setQty(Math.max(1, qty - 1))} className="px-3 py-2 text-lg font-bold text-gray-600">−</button>
                                    <span className="px-3 py-2 font-bold text-sm min-w-[2rem] text-center">{qty}</span>
                                    <button onClick={() => setQty(qty + 1)} className="px-3 py-2 text-lg font-bold text-gray-600">+</button>
                                </div>
                                <button onClick={handleAdd} className="flex-1 bg-mint-700 text-white py-2.5 rounded-lg font-bold text-sm">
                                    {language === "es" ? "Agregar" : "Add"} — ${(size.price * qty).toFixed(2)}
                                </button>
                            </div>
                            {addError && <p className="text-red-500 text-xs font-bold">⚠️ {addError}</p>}
                        </div>
                    )}
                </div>
            );
        }
export default function CateringOrder({ language, staffName }) {
            const [step, setStep] = useState(1);
            const [customer, setCustomer] = useState({
                name: "", phone: "", email: "", date: "", time: "", guests: "", address: "",
                orderType: "pickup", pickupLocation: ""
            });
            const [cart, setCart] = useState([]);
            const [errors, setErrors] = useState({});
            const [submitted, setSubmitted] = useState(false);
            const [orderHistory, setOrderHistory] = useState([]);
            const [showHistory, setShowHistory] = useState(false);
            const [specialNotes, setSpecialNotes] = useState("");
            const [deliveryFee, setDeliveryFee] = useState("15");
            const [viewingOrder, setViewingOrder] = useState(null);
            const [editingOrderId, setEditingOrderId] = useState(null);
            const [wantPlates, setWantPlates] = useState(false);
            const [plateCount, setPlateCount] = useState(0);
            const [wantChopsticks, setWantChopsticks] = useState(false);
            const [chopstickCount, setChopstickCount] = useState(0);
            const [taxExempt, setTaxExempt] = useState(false);
            const [customItemName, setCustomItemName] = useState("");
            const [customItemPrice, setCustomItemPrice] = useState("");
            const [customItemQty, setCustomItemQty] = useState(1);
            const [customItemNote, setCustomItemNote] = useState("");
            const [customItemOpen, setCustomItemOpen] = useState(false);
            const [pageTab, setPageTab] = useState("catering");
            useEffect(() => {
                const unsubscribe = onSnapshot(query(collection(db, "cateringOrders"), orderBy("createdAt", "desc"), limit(30)), snap => {
                    setOrderHistory(snap.docs.map(d => ({ id: d.id, ...d.data() })));
                });
                return () => unsubscribe();
            }, []);
            const validateCustomer = () => {
                const e = {};
                if (!customer.name.trim()) e.name = true;
                if (!customer.phone.trim()) e.phone = true;
                if (!customer.email.trim()) e.email = true;
                if (!customer.date) e.date = true;
                if (!customer.time.trim()) e.time = true;
                if (!customer.guests) e.guests = true;
                if (customer.orderType === "delivery" && !customer.address.trim()) e.address = true;
                if (!customer.pickupLocation) e.pickupLocation = true;
                setErrors(e);
                return Object.keys(e).length === 0;
            };
            const goToMenu = () => { if (validateCustomer()) setStep(2); };
            const addToCart = (item, sizeIdx, sauces, proteins, base, utensils, qty, itemNote, extras) => {
                const size = item.sizes[sizeIdx];
                setCart(prev => [...prev, {
                    id: Date.now() + Math.random(),
                    name: language === "es" ? (item.nameEs || item.name) : item.name,
                    nameEn: item.name,
                    size: size.label,
                    price: size.price,
                    qty: qty || 1,
                    sauces: sauces || [],
                    proteins: proteins || [],
                    base: base || "",
                    utensils: utensils || "",
                    itemNote: itemNote || "",
                    type: extras?.type || "",
                    singleSauce: extras?.singleSauce || "",
                    samplerProteins: extras?.samplerProteins || null,
                    samplerEggRoll: extras?.samplerEggRoll || ""
                }]);
            };
            const addCustomItem = () => {
                if (!customItemName.trim() || !customItemPrice) return;
                setCart(prev => [...prev, {
                    id: Date.now() + Math.random(),
                    name: customItemName.trim(),
                    nameEn: customItemName.trim(),
                    size: "Custom",
                    price: parseFloat(customItemPrice) || 0,
                    qty: customItemQty || 1,
                    sauces: [], proteins: [], base: "", utensils: "",
                    itemNote: customItemNote || "",
                    type: "", singleSauce: "", samplerProteins: null, samplerEggRoll: "",
                    isCustom: true
                }]);
                setCustomItemName(""); setCustomItemPrice(""); setCustomItemQty(1); setCustomItemNote(""); setCustomItemOpen(false);
            };
            const removeFromCart = (id) => setCart(prev => prev.filter(i => i.id !== id));
            const getSubtotal = () => cart.reduce((sum, i) => sum + i.price * i.qty, 0);
            const getUtensilCost = () => (wantPlates ? plateCount * 1 : 0) + (wantChopsticks ? chopstickCount * 0.5 : 0);
            const getDelFee = () => customer.orderType === "delivery" ? (parseFloat(deliveryFee) || 0) : 0;
            const TAX_RATES = { maryland: 0.08238, webster: 0.101 };
            const getTaxRate = () => TAX_RATES[customer.pickupLocation] || 0;
            const getTaxableAmount = () => getSubtotal() + getUtensilCost();
            const getTax = () => taxExempt ? 0 : Math.round(getTaxableAmount() * getTaxRate() * 100) / 100;
            const getTotal = () => getSubtotal() + getUtensilCost() + getDelFee() + getTax();
            const submitOrder = async () => {
                if (cart.length === 0) return;
                const utensilInfo = {};
                if (wantPlates && plateCount > 0) utensilInfo.plates = plateCount;
                if (wantChopsticks && chopstickCount > 0) utensilInfo.chopsticks = chopstickCount;
                utensilInfo.cost = getUtensilCost();
                const order = {
                    customer,
                    items: cart.map(({ id, ...rest }) => rest),
                    utensils: utensilInfo,
                    subtotal: getSubtotal(),
                    utensilCost: getUtensilCost(),
                    deliveryFee: getDelFee(),
                    taxExempt,
                    taxRate: getTaxRate(),
                    tax: getTax(),
                    total: getTotal(),
                    specialNotes,
                    takenBy: staffName,
                    createdAt: editingOrderId ? undefined : new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                    status: "new"
                };
                try {
                    if (editingOrderId) {
                        delete order.createdAt;
                        await setDoc(doc(db, "cateringOrders", editingOrderId), order, { merge: true });
                    } else {
                        await addDoc(collection(db, "cateringOrders"), order);
                    }
                    setSubmitted(true);
                } catch (err) { console.error("Error submitting catering order:", err); }
            };
            const resetForm = () => {
                setCustomer({ name: "", phone: "", email: "", date: "", time: "", guests: "", address: "", orderType: "pickup", pickupLocation: "" });
                setCart([]); setErrors({}); setSubmitted(false); setSpecialNotes(""); setStep(1);
                setDeliveryFee("15"); setEditingOrderId(null);
                setWantPlates(false); setPlateCount(0); setWantChopsticks(false); setChopstickCount(0);
            };
            const loadOrderForEdit = (o) => {
                setCustomer(o.customer || {});
                setCart((o.items || []).map((item, i) => ({ ...item, id: Date.now() + i })));
                setSpecialNotes(o.specialNotes || "");
                setDeliveryFee(String(o.deliveryFee || 15));
                if (o.utensils?.plates) { setWantPlates(true); setPlateCount(o.utensils.plates); } else { setWantPlates(false); setPlateCount(0); }
                if (o.utensils?.chopsticks) { setWantChopsticks(true); setChopstickCount(o.utensils.chopsticks); } else { setWantChopsticks(false); setChopstickCount(0); }
                setEditingOrderId(o.id);
                setShowHistory(false);
                setViewingOrder(null);
                setStep(3);
            };
            const buildInvoiceHTML = (o) => {
                const c = o.customer || {};
                const itemsHTML = (o.items || []).map((item, i) => {
                    let details = item.isCustom ? "Custom Item" : item.size;
                    if (item.type) details += ' | Type: ' + item.type;
                    if (item.proteins && item.proteins.length) details += ' | Proteins: ' + item.proteins.join(', ');
                    if (item.sauces && item.sauces.length) details += ' | Sauces: ' + item.sauces.join(', ');
                    if (item.singleSauce) details += ' | Sauce: ' + item.singleSauce;
                    if (item.base) details += ' | Base: ' + item.base;
                    if (item.utensils) details += ' | ' + item.utensils;
                    if (item.samplerProteins) {
                        const names = ['Banh Mi', 'Mini Bowls', 'Rice Rolls'];
                        item.samplerProteins.forEach((sp, si) => { if (sp && sp.length) details += ' | ' + names[si] + ': ' + sp.join(', '); });
                    }
                    if (item.samplerEggRoll) details += ' | Egg Rolls: ' + item.samplerEggRoll;
                    if (item.itemNote) details += ' | Note: ' + item.itemNote;
                    return `<tr>
                        <td style="padding:8px 6px;border-bottom:1px solid #ddd;font-weight:bold;vertical-align:top">${i+1}</td>
                        <td style="padding:8px 6px;border-bottom:1px solid #ddd"><strong>${item.nameEn || item.name}</strong><br><span style="color:#555;font-size:12px">${details}</span></td>
                        <td style="padding:8px 6px;border-bottom:1px solid #ddd;text-align:center;font-weight:bold">${item.qty}</td>
                        <td style="padding:8px 6px;border-bottom:1px solid #ddd;text-align:right">$${item.price?.toFixed(2)}</td>
                        <td style="padding:8px 6px;border-bottom:1px solid #ddd;text-align:right;font-weight:bold">$${(item.price * item.qty)?.toFixed(2)}</td>
                    </tr>`;
                }).join('');
                return `<!DOCTYPE html><html><head><title>DD Mau Catering - ${c.name}</title>
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <style>
                    *{box-sizing:border-box}
                    body{font-family:-apple-system,Helvetica,Arial,sans-serif;max-width:800px;margin:0 auto;padding:20px;color:#333;background:#fff}
                    .invoice{background:#fff;border:2px solid #255a37;border-radius:8px;overflow:hidden}
                    .header{background:#255a37;color:white;padding:20px;text-align:center}
                    .header h1{margin:0;font-size:24px;letter-spacing:1px} .header p{margin:4px 0 0;opacity:.8;font-size:14px}
                    .order-num{background:#1a4028;color:#8fbc8f;text-align:center;padding:6px;font-size:13px;font-weight:bold;letter-spacing:2px}
                    .info-grid{display:flex;gap:12px;padding:16px}
                    .info-box{flex:1;background:#f4faf5;border:1px solid #c8e6c9;border-radius:6px;padding:12px}
                    .info-box h3{margin:0 0 6px;color:#255a37;font-size:11px;text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid #c8e6c9;padding-bottom:4px}
                    .info-box p{margin:2px 0;font-size:13px;line-height:1.5}
                    .notes{margin:0 16px 12px;background:#fff9e6;border:1px solid #f0d060;border-radius:6px;padding:10px;font-size:13px}
                    table{width:100%;border-collapse:collapse}
                    th{background:#2d6e42;color:white;padding:10px 6px;font-size:12px;text-align:left;text-transform:uppercase;letter-spacing:.5px}
                    th:nth-child(1){width:30px} th:nth-child(3){text-align:center;width:45px} th:nth-child(4),th:nth-child(5){text-align:right;width:75px}
                    .totals{padding:16px;background:#f4faf5}
                    .totals .line{display:flex;justify-content:flex-end;gap:40px;padding:4px 0;font-size:14px}
                    .totals .total-line{font-size:20px;font-weight:bold;color:#255a37;border-top:3px solid #255a37;padding-top:10px;margin-top:8px}
                    .footer{text-align:center;color:#888;font-size:11px;padding:12px;border-top:1px solid #ddd}
                    .no-print{margin:16px 0;text-align:center}
                    .no-print button{padding:12px 24px;font-size:16px;font-weight:bold;border:none;border-radius:8px;cursor:pointer;margin:0 6px}
                    .btn-print{background:#255a37;color:white} .btn-edit{background:#f59e0b;color:white} .btn-close{background:#e5e7eb;color:#555}
                    @media print{.no-print{display:none !important} body{padding:0;margin:0} .invoice{border:none}}
                </style></head><body>
                <div class="invoice">
                    <div class="header">
                        <h1>DD Mau Vietnamese Eatery</h1>
                        <p>Catering Order Invoice</p>
                    </div>
                    <div class="order-num">ORDER #${o.id?.slice(-6).toUpperCase() || "------"}</div>
                    <div class="info-grid">
                        <div class="info-box">
                            <h3>Customer</h3>
                            <p><strong>${c.name}</strong></p>
                            <p>Phone: ${c.phone}</p>
                            <p>Email: ${c.email}</p>
                        </div>
                        <div class="info-box">
                            <h3>Event Details</h3>
                            <p>Date: ${c.date} @ ${c.time}</p>
                            <p>Guests: ${c.guests}</p>
                            <p>Store: ${c.pickupLocation === "maryland" ? "Maryland Heights" : "Webster"}</p>
                            <p>${c.orderType === "delivery" ? "Delivery: " + (c.address || "TBD") : "Pickup"}</p>
                        </div>
                    </div>
                    ${o.specialNotes ? '<div class="notes"><strong>Special Notes:</strong> ' + o.specialNotes + '</div>' : ''}
                    <table>
                        <thead><tr><th>#</th><th>Item</th><th>Qty</th><th style="text-align:right">Price</th><th style="text-align:right">Total</th></tr></thead>
                        <tbody>${itemsHTML}</tbody>
                    </table>
                    <div class="totals">
                        <div class="line"><span>Subtotal:</span><span>$${o.subtotal?.toFixed(2)}</span></div>
                        ${(o.utensilCost || 0) > 0 ? '<div class="line"><span>Utensils (' + (o.utensils?.plates ? o.utensils.plates + ' plates' : '') + (o.utensils?.plates && o.utensils?.chopsticks ? ', ' : '') + (o.utensils?.chopsticks ? o.utensils.chopsticks + ' chopsticks' : '') + '):</span><span>$' + o.utensilCost.toFixed(2) + '</span></div>' : ''}
                        ${o.deliveryFee > 0 ? '<div class="line"><span>Delivery Fee:</span><span>$' + o.deliveryFee?.toFixed(2) + '</span></div>' : ''}
                        <div class="line"><span>Tax (${o.taxRate ? (o.taxRate * 100).toFixed(3) : "0"}%):</span><span>$${(o.tax || 0).toFixed(2)}</span></div>
                        <div class="line total-line"><span>TOTAL:</span><span>$${o.total?.toFixed(2)}</span></div>
                    </div>
                    <div class="footer">
                        <p>Taken by: ${o.takenBy || "Staff"} | ${o.createdAt ? new Date(o.createdAt).toLocaleString() : ""}</p>
                        ${o.updatedAt && o.updatedAt !== o.createdAt ? '<p>Updated: ' + new Date(o.updatedAt).toLocaleString() + '</p>' : ''}
                        <p>DD Mau Vietnamese Eatery — ddmaustl.com</p>
                    </div>
                </div>
                </body></html>`;
            };
            const printOrder = (o) => {
                const w = window.open('', '_blank', 'width=800,height=1100');
                if (!w) { alert('Please allow popups to print this order, or use the Share button on your phone.'); return; }
                w.document.write(buildInvoiceHTML(o));
                w.document.close();
                setTimeout(() => w.print(), 300);
            };
            // Success screen
            if (pageTab === "catering" && submitted) {
                return (
                    <div className="p-4 pb-24">
                        <div className="max-w-lg mx-auto text-center mt-8">
                            <div className="text-6xl mb-4">✅</div>
                            <h2 className="text-2xl font-bold text-mint-700 mb-2">{editingOrderId ? (language === "es" ? "¡Pedido Actualizado!" : "Order Updated!") : (language === "es" ? "¡Pedido Enviado!" : "Order Submitted!")}</h2>
                            <p className="text-gray-600 mb-2">{customer.name} — {customer.phone}</p>
                            <p className="text-gray-600 mb-2">{customer.date} @ {customer.time} — {customer.guests} {language === "es" ? "personas" : "guests"}</p>
                            <p className="text-gray-600 mb-2">🏪 {customer.pickupLocation === "maryland" ? "Maryland Heights" : "Webster"} — {customer.orderType === "pickup" ? (language === "es" ? "Recogida" : "Pickup") : "🚗 " + (language === "es" ? "Entrega" : "Delivery")}</p>
                            <p className="text-lg font-bold text-mint-700 mb-6">${getTotal().toFixed(2)}</p>
                            <p className="text-xs text-gray-400 mb-6">{language === "es" ? "Tomado por" : "Taken by"}: {staffName}</p>
                            <button onClick={resetForm} className="bg-mint-700 text-white px-6 py-3 rounded-lg font-bold text-lg">
                                {language === "es" ? "Nuevo Pedido" : "New Order"}
                            </button>
                        </div>
                    </div>
                );
            }
            // Full Invoice Detail View
            if (pageTab === "catering" && viewingOrder) {
                const vo = viewingOrder;
                const vc = vo.customer || {};
                return (
                    <div className="p-2 pb-24">
                        <div className="flex gap-2 mb-3">
                            <button onClick={() => setViewingOrder(null)} className="px-4 py-3 bg-gray-200 text-gray-700 rounded-lg font-bold text-sm">← {language === "es" ? "Volver" : "Back"}</button>
                            <button onClick={() => loadOrderForEdit(vo)} className="flex-1 py-3 bg-amber-500 text-white rounded-lg font-bold text-sm">✏️ {language === "es" ? "Editar Pedido" : "Edit Order"}</button>
                            <button onClick={() => printOrder(vo)} className="flex-1 py-3 bg-blue-600 text-white rounded-lg font-bold text-sm">🖨️ {language === "es" ? "Imprimir" : "Print"}</button>
                        </div>
                        <div className="bg-white border-2 border-gray-300 rounded-lg overflow-hidden shadow-xl" style={{minHeight: "80vh"}}>
                            <div style={{background: "#255a37", color: "white", padding: "20px", textAlign: "center"}}>
                                <h2 className="text-2xl font-bold" style={{margin: 0, letterSpacing: "1px"}}>DD Mau Vietnamese Eatery</h2>
                                <p style={{margin: "4px 0 0", opacity: 0.85, fontSize: "14px"}}>{language === "es" ? "Factura de Catering" : "Catering Invoice"}</p>
                            </div>
                            <div style={{background: "#1a4028", color: "#8fbc8f", textAlign: "center", padding: "6px", fontSize: "13px", fontWeight: "bold", letterSpacing: "2px"}}>
                                ORDER #{vo.id?.slice(-6).toUpperCase()}
                            </div>
                            <div style={{display: "flex", gap: "10px", padding: "16px"}}>
                                <div style={{flex: 1, background: "#f4faf5", border: "1px solid #c8e6c9", borderRadius: "8px", padding: "12px"}}>
                                    <p style={{margin: "0 0 6px", fontSize: "11px", fontWeight: "bold", color: "#255a37", textTransform: "uppercase", letterSpacing: "1px", borderBottom: "1px solid #c8e6c9", paddingBottom: "4px"}}>{language === "es" ? "CLIENTE" : "CUSTOMER"}</p>
                                    <p style={{margin: "2px 0", fontWeight: "bold", fontSize: "15px"}}>{vc.name}</p>
                                    <p style={{margin: "2px 0", fontSize: "13px", color: "#555"}}>📞 {vc.phone}</p>
                                    <p style={{margin: "2px 0", fontSize: "13px", color: "#555"}}>✉️ {vc.email}</p>
                                </div>
                                <div style={{flex: 1, background: "#f4faf5", border: "1px solid #c8e6c9", borderRadius: "8px", padding: "12px"}}>
                                    <p style={{margin: "0 0 6px", fontSize: "11px", fontWeight: "bold", color: "#255a37", textTransform: "uppercase", letterSpacing: "1px", borderBottom: "1px solid #c8e6c9", paddingBottom: "4px"}}>{language === "es" ? "EVENTO" : "EVENT"}</p>
                                    <p style={{margin: "2px 0", fontSize: "13px"}}>📅 {vc.date} @ {vc.time}</p>
                                    <p style={{margin: "2px 0", fontSize: "13px"}}>👥 {vc.guests} {language === "es" ? "personas" : "guests"}</p>
                                    <p style={{margin: "2px 0", fontSize: "13px"}}>{"🏪 " + (vc.pickupLocation === "maryland" ? "Maryland Heights" : "Webster") + " — " + (vc.orderType === "delivery" ? "🚗 " + (vc.address || "Delivery") : "Pickup")}</p>
                                </div>
                            </div>
                            {vo.specialNotes && (
                                <div style={{margin: "0 16px 12px", background: "#fff9e6", border: "1px solid #f0d060", borderRadius: "6px", padding: "10px", fontSize: "13px"}}>
                                    📝 <strong>{language === "es" ? "Notas Especiales" : "Special Notes"}:</strong> {vo.specialNotes}
                                </div>
                            )}
                            <div style={{padding: "0 16px"}}>
                                <table style={{width: "100%", borderCollapse: "collapse"}}>
                                    <thead>
                                        <tr style={{background: "#2d6e42", color: "white"}}>
                                            <th style={{padding: "10px 6px", fontSize: "12px", textAlign: "left", width: "30px"}}>#</th>
                                            <th style={{padding: "10px 6px", fontSize: "12px", textAlign: "left"}}>{language === "es" ? "Artículo" : "Item"}</th>
                                            <th style={{padding: "10px 6px", fontSize: "12px", textAlign: "center", width: "40px"}}>Qty</th>
                                            <th style={{padding: "10px 6px", fontSize: "12px", textAlign: "right", width: "65px"}}>{language === "es" ? "Precio" : "Price"}</th>
                                            <th style={{padding: "10px 6px", fontSize: "12px", textAlign: "right", width: "65px"}}>Total</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {(vo.items || []).map((item, i) => (
                                            <tr key={i} style={{borderBottom: "1px solid #ddd"}}>
                                                <td style={{padding: "8px 6px", fontWeight: "bold", verticalAlign: "top", fontSize: "13px"}}>{i+1}</td>
                                                <td style={{padding: "8px 6px", fontSize: "13px"}}>
                                                    <strong>{item.nameEn || item.name}</strong>
                                                    <br/><span style={{color: "#555", fontSize: "12px"}}>
                                                        {item.size}
                                                        {item.type ? ` | Type: ${item.type}` : ""}
                                                        {item.proteins?.length > 0 ? ` | Proteins: ${item.proteins.join(", ")}` : ""}
                                                        {item.sauces?.length > 0 ? ` | Sauces: ${item.sauces.join(", ")}` : ""}
                                                        {item.singleSauce ? ` | Sauce: ${item.singleSauce}` : ""}
                                                        {item.base ? ` | Base: ${item.base}` : ""}
                                                        {item.utensils ? ` | ${item.utensils}` : ""}
                                                        {item.samplerEggRoll ? ` | Egg Rolls: ${item.samplerEggRoll}` : ""}
                                                    </span>
                                                    {item.samplerProteins && item.samplerProteins.map((sp, si) => sp?.length > 0 && (
                                                        <span key={si} style={{display: "block", color: "#555", fontSize: "12px"}}>• {["Banh Mi", "Mini Bowls", "Rice Rolls"][si]}: {sp.join(", ")}</span>
                                                    ))}
                                                    {item.itemNote && <span style={{display: "block", color: "#d97706", fontSize: "12px", fontStyle: "italic"}}>📝 {item.itemNote}</span>}
                                                </td>
                                                <td style={{padding: "8px 6px", textAlign: "center", fontWeight: "bold", verticalAlign: "top", fontSize: "13px"}}>{item.qty}</td>
                                                <td style={{padding: "8px 6px", textAlign: "right", verticalAlign: "top", fontSize: "13px"}}>${item.price?.toFixed(2)}</td>
                                                <td style={{padding: "8px 6px", textAlign: "right", fontWeight: "bold", verticalAlign: "top", fontSize: "13px"}}>${(item.price * item.qty)?.toFixed(2)}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                            <div style={{padding: "16px", background: "#f4faf5", marginTop: "8px"}}>
                                <div style={{display: "flex", justifyContent: "flex-end", gap: "40px", padding: "4px 0", fontSize: "14px"}}>
                                    <span>Subtotal:</span><span style={{fontWeight: "bold"}}>${vo.subtotal?.toFixed(2)}</span>
                                </div>
                                {(vo.utensilCost || 0) > 0 && (
                                    <div style={{display: "flex", justifyContent: "flex-end", gap: "40px", padding: "4px 0", fontSize: "14px"}}>
                                        <span>🍴 {language === "es" ? "Cubiertos" : "Utensils"} ({[vo.utensils?.plates ? vo.utensils.plates + " " + (language === "es" ? "platos" : "plates") : "", vo.utensils?.chopsticks ? vo.utensils.chopsticks + " " + (language === "es" ? "palillos" : "chopsticks") : ""].filter(Boolean).join(", ")}):</span>
                                        <span style={{fontWeight: "bold"}}>${vo.utensilCost?.toFixed(2)}</span>
                                    </div>
                                )}
                                {vo.deliveryFee > 0 && (
                                    <div style={{display: "flex", justifyContent: "flex-end", gap: "40px", padding: "4px 0", fontSize: "14px"}}>
                                        <span>{language === "es" ? "Entrega" : "Delivery Fee"}:</span><span style={{fontWeight: "bold"}}>${vo.deliveryFee?.toFixed(2)}</span>
                                    </div>
                                )}
                                <div style={{display: "flex", justifyContent: "flex-end", gap: "40px", padding: "4px 0", fontSize: "14px"}}>
                                    <span>{language === "es" ? "Impuesto" : "Tax"} ({vo.taxRate ? (vo.taxRate * 100).toFixed(3) : "0"}%):</span>
                                    <span style={{fontWeight: "bold"}}>${(vo.tax || 0).toFixed(2)}</span>
                                </div>
                                <div style={{display: "flex", justifyContent: "flex-end", gap: "40px", padding: "10px 0 0", fontSize: "22px", fontWeight: "bold", color: "#255a37", borderTop: "3px solid #255a37", marginTop: "8px"}}>
                                    <span>TOTAL:</span><span>${vo.total?.toFixed(2)}</span>
                                </div>
                            </div>
                            <div style={{textAlign: "center", color: "#888", fontSize: "11px", padding: "12px", borderTop: "1px solid #ddd"}}>
                                <p style={{margin: "2px 0"}}>{language === "es" ? "Tomado por" : "Taken by"}: {vo.takenBy} | {vo.createdAt ? new Date(vo.createdAt).toLocaleString() : ""}</p>
                                {vo.updatedAt && vo.updatedAt !== vo.createdAt && <p style={{margin: "2px 0"}}>{language === "es" ? "Actualizado" : "Updated"}: {new Date(vo.updatedAt).toLocaleString()}</p>}
                                <p style={{margin: "6px 0 0"}}>DD Mau Vietnamese Eatery — ddmaustl.com</p>
                                <span className={`inline-block mt-2 text-xs px-3 py-1 rounded-full font-bold ${vo.status === "new" ? "bg-amber-100 text-amber-700" : vo.status === "confirmed" ? "bg-blue-100 text-blue-700" : "bg-green-100 text-green-700"}`}>{vo.status?.toUpperCase()}</span>
                            </div>
                        </div>
                        <div className="flex gap-2 mt-3">
                            <button onClick={() => loadOrderForEdit(vo)} className="flex-1 py-3 bg-amber-500 text-white rounded-lg font-bold text-sm">✏️ {language === "es" ? "Editar Pedido" : "Edit Order"}</button>
                            <button onClick={() => printOrder(vo)} className="flex-1 py-3 bg-blue-600 text-white rounded-lg font-bold text-sm">🖨️ {language === "es" ? "Imprimir" : "Print"}</button>
                        </div>
                    </div>
                );
            }
            // Order History View
            if (pageTab === "catering" && showHistory) {
                return (
                    <div className="p-4 pb-24">
                        <div className="flex items-center justify-between mb-4">
                            <h2 className="text-xl font-bold text-mint-700">{language === "es" ? "Historial de Pedidos" : "Order History"}</h2>
                            <button onClick={() => setShowHistory(false)} className="text-sm bg-gray-100 px-3 py-1 rounded-full font-bold text-gray-600">✕ {language === "es" ? "Cerrar" : "Close"}</button>
                        </div>
                        {orderHistory.length === 0 && <p className="text-gray-400 text-center mt-8">{language === "es" ? "Sin pedidos aún" : "No orders yet"}</p>}
                        {orderHistory.map(o => (
                            <div key={o.id} className="mb-3 bg-white border-2 border-gray-200 rounded-lg p-3 cursor-pointer hover:border-mint-300 hover:shadow-md transition" onClick={() => setViewingOrder(o)}>
                                <div className="flex justify-between items-start">
                                    <div>
                                        <p className="font-bold text-gray-800">{o.customer?.name}</p>
                                        <p className="text-xs text-gray-500">{o.customer?.date} @ {o.customer?.time} — {o.customer?.guests} guests</p>
                                        <p className="text-xs text-gray-400">{"🏪 " + (o.customer?.pickupLocation === "maryland" ? "Maryland Heights" : "Webster") + " — " + (o.customer?.orderType === "delivery" ? "🚗 Delivery" : "Pickup")}</p>
                                    </div>
                                    <div className="text-right">
                                        <p className="font-bold text-mint-700">${o.total?.toFixed(2)}</p>
                                        <p className="text-xs text-gray-400">{o.takenBy}</p>
                                        <span className={`text-xs px-2 py-0.5 rounded-full font-bold ${o.status === "new" ? "bg-amber-100 text-amber-700" : o.status === "confirmed" ? "bg-blue-100 text-blue-700" : "bg-green-100 text-green-700"}`}>{o.status}</span>
                                    </div>
                                </div>
                                <div className="mt-2 text-xs text-gray-500">
                                    {(o.items || []).map((item, i) => (
                                        <span key={i}>{item.qty}x {item.nameEn || item.name} ({item.size}){i < o.items.length - 1 ? ", " : ""}</span>
                                    ))}
                                </div>
                                <p className="text-xs text-mint-600 font-bold mt-2 text-right">{language === "es" ? "Toca para ver detalles →" : "Tap to view details →"}</p>
                            </div>
                        ))}
                    </div>
                );
            }
            return (
                <div className="p-4 pb-24">
                    {/* ── Page Tab Bar ── */}
                    <div className="flex gap-2 mb-4">
                        <button onClick={() => setPageTab("catering")}
                            className={`flex-1 py-2.5 rounded-lg font-bold text-sm border-2 transition ${pageTab === "catering" ? "bg-mint-700 text-white border-mint-700" : "bg-white text-gray-600 border-gray-200"}`}>
                            📝 {language === "es" ? "Catering" : "Catering"}
                        </button>
                        <button onClick={() => setPageTab("invoices")}
                            className={`flex-1 py-2.5 rounded-lg font-bold text-sm border-2 transition ${pageTab === "invoices" ? "bg-mint-700 text-white border-mint-700" : "bg-white text-gray-600 border-gray-200"}`}>
                            🧾 {language === "es" ? "Pedidos Toast" : "Toast Orders"}
                        </button>
                    </div>

                    {/* ── Toast Orders Tab ── */}
                    {pageTab === "invoices" && <ToastInvoices language={language} />}

                    {/* ── Catering Tab ── */}
                    {pageTab === "catering" && (
                    <>
                    <div className="flex items-center justify-between mb-4">
                        <h2 className="text-2xl font-bold text-mint-700">🍜 {t("cateringOrders", language)}</h2>
                        <button onClick={() => setShowHistory(true)} className="text-xs bg-amber-100 text-amber-700 px-3 py-1.5 rounded-full font-bold border border-amber-300">
                            📋 {language === "es" ? "Historial" : "History"}
                        </button>
                    </div>
                    {editingOrderId && (
                        <div className="bg-amber-50 border border-amber-300 rounded-lg p-2 mb-4 text-xs text-amber-800 font-bold text-center">
                            ✏️ {language === "es" ? "Editando pedido existente" : "Editing existing order"} — #{editingOrderId.slice(-6).toUpperCase()}
                        </div>
                    )}
                    {/* Progress Steps */}
                    <div className="flex items-center justify-center gap-2 mb-6">
                        {[{n:1, label: language === "es" ? "Cliente" : "Customer"}, {n:2, label: language === "es" ? "Menú" : "Menu"}, {n:3, label: language === "es" ? "Resumen" : "Summary"}].map(s => (
                            <div key={s.n} className="flex items-center gap-2">
                                <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold ${step >= s.n ? "bg-mint-700 text-white" : "bg-gray-200 text-gray-500"}`}>{s.n}</div>
                                <span className={`text-xs font-bold ${step >= s.n ? "text-mint-700" : "text-gray-400"}`}>{s.label}</span>
                                {s.n < 3 && <span className="text-gray-300 mx-1">→</span>}
                            </div>
                        ))}
                    </div>
                    {/* Step 1: Customer Info */}
                    {step === 1 && (
                        <div className="space-y-3">
                            <div className="bg-cyan-50 border border-cyan-200 rounded-lg p-3 text-xs text-cyan-700 mb-4">
                                📞 {language === "es" ? "Completa toda la información del cliente. Todos los campos son obligatorios." : "Fill in all customer info. All fields are required."}
                            </div>
                            <div className="flex gap-2 mb-2">
                                <button onClick={() => setCustomer(p => ({...p, orderType: "pickup"}))}
                                    className={`flex-1 py-3 rounded-lg font-bold text-sm border-2 transition ${customer.orderType === "pickup" ? "bg-mint-700 text-white border-mint-700" : "bg-white text-gray-600 border-gray-200"}`}>
                                    🏪 {t("pickup", language)}
                                </button>
                                <button onClick={() => setCustomer(p => ({...p, orderType: "delivery"}))}
                                    className={`flex-1 py-3 rounded-lg font-bold text-sm border-2 transition ${customer.orderType === "delivery" ? "bg-mint-700 text-white border-mint-700" : "bg-white text-gray-600 border-gray-200"}`}>
                                    🚗 {t("delivery", language)}
                                </button>
                            </div>
                            <div>
                                <label className="block text-xs font-bold text-gray-600 mb-1">🏪 {customer.orderType === "delivery" ? (language === "es" ? "Pedido Desde" : "Order From") : (language === "es" ? "Ubicación de Recogida" : "Pickup Location")} *</label>
                                <div className="flex gap-2">
                                    {[
                                        { id: "maryland", label: "Maryland Heights", labelEs: "Maryland Heights" },
                                        { id: "webster", label: "Webster", labelEs: "Webster" }
                                    ].map(loc => (
                                        <button key={loc.id} onClick={() => { setCustomer(p => ({...p, pickupLocation: loc.id})); setErrors(p => ({...p, pickupLocation: false})); }}
                                            className={`flex-1 py-2.5 rounded-lg font-bold text-sm border-2 transition ${customer.pickupLocation === loc.id ? "bg-emerald-700 text-white border-emerald-700" : errors.pickupLocation ? "bg-red-50 text-gray-600 border-red-400" : "bg-white text-gray-600 border-gray-200"}`}>
                                            {language === "es" ? loc.labelEs : loc.label}
                                        </button>
                                    ))}
                                </div>
                            </div>
                            {customer.orderType === "delivery" && (
                                <div className="flex items-center gap-2 bg-amber-50 border border-amber-200 rounded-lg p-2">
                                    <label className="text-xs font-bold text-amber-700">{language === "es" ? "Tarifa de Entrega: $" : "Delivery Fee: $"}</label>
                                    <input value={deliveryFee} onChange={e => setDeliveryFee(e.target.value)}
                                        type="number" min="0" step="0.01" className="w-20 border border-amber-300 rounded px-2 py-1 text-sm font-bold text-center" />
                                </div>
                            )}
                            <div>
                                <label className="block text-xs font-bold text-gray-600 mb-1">{language === "es" ? "Nombre" : "Name"} *</label>
                                <input value={customer.name} onChange={e => { setCustomer(p => ({...p, name: e.target.value})); setErrors(p => ({...p, name: false})); }}
                                    className={`w-full border-2 ${errors.name ? "border-red-400 bg-red-50" : "border-gray-200"} rounded-lg px-3 py-3 text-sm font-medium`} placeholder={language === "es" ? "Nombre completo" : "Full name"} />
                            </div>
                            <div>
                                <label className="block text-xs font-bold text-gray-600 mb-1">{language === "es" ? "Teléfono" : "Phone"} *</label>
                                <input value={customer.phone} onChange={e => { setCustomer(p => ({...p, phone: e.target.value})); setErrors(p => ({...p, phone: false})); }}
                                    type="tel" className={`w-full border-2 ${errors.phone ? "border-red-400 bg-red-50" : "border-gray-200"} rounded-lg px-3 py-3 text-sm font-medium`} placeholder="(314) 555-1234" />
                            </div>
                            <div>
                                <label className="block text-xs font-bold text-gray-600 mb-1">Email *</label>
                                <input value={customer.email} onChange={e => { setCustomer(p => ({...p, email: e.target.value})); setErrors(p => ({...p, email: false})); }}
                                    type="email" className={`w-full border-2 ${errors.email ? "border-red-400 bg-red-50" : "border-gray-200"} rounded-lg px-3 py-3 text-sm font-medium`} placeholder="email@example.com" />
                            </div>
                            <div className="grid grid-cols-2 gap-3">
                                <div>
                                    <label className="block text-xs font-bold text-gray-600 mb-1">{language === "es" ? "Fecha del Evento" : "Event Date"} *</label>
                                    <input value={customer.date} onChange={e => { setCustomer(p => ({...p, date: e.target.value})); setErrors(p => ({...p, date: false})); }}
                                        type="date" className={`w-full border-2 ${errors.date ? "border-red-400 bg-red-50" : "border-gray-200"} rounded-lg px-3 py-3 text-sm font-medium`} />
                                </div>
                                <div>
                                    <label className="block text-xs font-bold text-gray-600 mb-1">{language === "es" ? "Hora" : "Time"} *</label>
                                    <select value={customer.time} onChange={e => { setCustomer(p => ({...p, time: e.target.value})); setErrors(p => ({...p, time: false})); }}
                                        className={`w-full border-2 ${errors.time ? "border-red-400 bg-red-50" : "border-gray-200"} rounded-lg px-3 py-3 text-sm font-medium bg-white`}>
                                        <option value="">{language === "es" ? "Seleccionar hora" : "Select time"}</option>
                                        {(() => { const opts = []; for (let h = 8; h <= 21; h++) { for (let m = 0; m < 60; m += 30) { const hour12 = h > 12 ? h - 12 : h === 0 ? 12 : h; const ampm = h >= 12 ? "PM" : "AM"; const label = `${hour12}:${m === 0 ? "00" : m} ${ampm}`; opts.push(<option key={`${h}-${m}`} value={label}>{label}</option>); } } return opts; })()}
                                    </select>
                                </div>
                            </div>
                            <div>
                                <label className="block text-xs font-bold text-gray-600 mb-1">{language === "es" ? "¿Cuántas Personas?" : "How Many Guests?"} *</label>
                                <input value={customer.guests} onChange={e => { setCustomer(p => ({...p, guests: e.target.value})); setErrors(p => ({...p, guests: false})); }}
                                    type="number" min="1" className={`w-full border-2 ${errors.guests ? "border-red-400 bg-red-50" : "border-gray-200"} rounded-lg px-3 py-3 text-sm font-medium`} placeholder="25" />
                            </div>
                            {customer.orderType === "delivery" && (
                                <div>
                                    <label className="block text-xs font-bold text-gray-600 mb-1">{language === "es" ? "Dirección de Entrega" : "Delivery Address"} *</label>
                                    <input value={customer.address} onChange={e => { setCustomer(p => ({...p, address: e.target.value})); setErrors(p => ({...p, address: false})); }}
                                        className={`w-full border-2 ${errors.address ? "border-red-400 bg-red-50" : "border-gray-200"} rounded-lg px-3 py-3 text-sm font-medium`} placeholder={language === "es" ? "Dirección completa" : "Full address"} />
                                </div>
                            )}
                            {Object.values(errors).some(Boolean) && (
                                <p className="text-red-500 text-xs font-bold text-center">⚠️ {language === "es" ? "Completa todos los campos requeridos" : "Please fill in all required fields"}</p>
                            )}
                            <button onClick={goToMenu} className="w-full bg-mint-700 text-white py-3 rounded-lg font-bold text-lg mt-2">
                                {language === "es" ? "Siguiente → Menú" : "Next → Menu"} 🍜
                            </button>
                        </div>
                    )}
                    {/* Step 2: Menu Items */}
                    {step === 2 && (
                        <div>
                            {cart.length > 0 && (
                                <div className="sticky top-16 z-30 bg-mint-700 text-white rounded-lg p-3 mb-4 flex justify-between items-center shadow-lg">
                                    <span className="font-bold">🛒 {cart.length} {language === "es" ? "artículos" : "items"} — ${getSubtotal().toFixed(2)}</span>
                                    <button onClick={() => setStep(3)} className="bg-white text-mint-700 px-4 py-1.5 rounded-full font-bold text-sm">
                                        {language === "es" ? "Ver Resumen" : "Review"} →
                                    </button>
                                </div>
                            )}
                            <div className="mb-6">
                                <h3 className="text-lg font-bold text-gray-800 mb-3 border-b-2 border-mint-200 pb-1">
                                    🍴 {language === "es" ? "Cubiertos y Extras" : "Utensils & Extras"}
                                </h3>
                                <div className="bg-white border-2 border-gray-200 rounded-lg p-3 space-y-3">
                                    <div className="flex items-center gap-2">
                                        <button onClick={() => { setWantPlates(!wantPlates); if (wantPlates) setPlateCount(0); else setPlateCount(10); }}
                                            className={`flex-1 px-3 py-2.5 rounded-lg text-xs font-bold border-2 transition text-left ${wantPlates ? "bg-purple-500 text-white border-purple-500" : "bg-white text-gray-600 border-gray-200"}`}>
                                            🍽️ {language === "es" ? "Platos y Cubiertos" : "Plates & Utensils"} ($1.00/{language === "es" ? "c/u" : "ea"}) {wantPlates ? "✓" : ""}
                                        </button>
                                        {wantPlates && (
                                            <div className="flex items-center bg-white border-2 border-purple-300 rounded-lg overflow-hidden">
                                                <button onClick={() => setPlateCount(Math.max(1, plateCount - 1))} className="px-2.5 py-1.5 text-purple-600 font-bold text-sm active:bg-purple-50">−</button>
                                                <input value={plateCount} onChange={e => setPlateCount(Math.max(0, parseInt(e.target.value) || 0))}
                                                    type="number" min="1"
                                                    className="w-12 text-center text-sm font-bold border-x border-purple-200 py-1.5 appearance-none"
                                                    style={{MozAppearance: "textfield", WebkitAppearance: "none"}} />
                                                <button onClick={() => setPlateCount(plateCount + 1)} className="px-2.5 py-1.5 text-purple-600 font-bold text-sm active:bg-purple-50">+</button>
                                            </div>
                                        )}
                                    </div>
                                    {wantPlates && <p className="text-xs text-purple-500 ml-1">🍽️ {plateCount} × $1.00 = ${(plateCount * 1).toFixed(2)}</p>}
                                    <div className="flex items-center gap-2">
                                        <button onClick={() => { setWantChopsticks(!wantChopsticks); if (wantChopsticks) setChopstickCount(0); else setChopstickCount(10); }}
                                            className={`flex-1 px-3 py-2.5 rounded-lg text-xs font-bold border-2 transition text-left ${wantChopsticks ? "bg-purple-500 text-white border-purple-500" : "bg-white text-gray-600 border-gray-200"}`}>
                                            🥢 {language === "es" ? "Palillos" : "Chopsticks"} ($0.50/{language === "es" ? "c/u" : "ea"}) {wantChopsticks ? "✓" : ""}
                                        </button>
                                        {wantChopsticks && (
                                            <div className="flex items-center bg-white border-2 border-purple-300 rounded-lg overflow-hidden">
                                                <button onClick={() => setChopstickCount(Math.max(1, chopstickCount - 1))} className="px-2.5 py-1.5 text-purple-600 font-bold text-sm active:bg-purple-50">−</button>
                                                <input value={chopstickCount} onChange={e => setChopstickCount(Math.max(0, parseInt(e.target.value) || 0))}
                                                    type="number" min="1"
                                                    className="w-12 text-center text-sm font-bold border-x border-purple-200 py-1.5 appearance-none"
                                                    style={{MozAppearance: "textfield", WebkitAppearance: "none"}} />
                                                <button onClick={() => setChopstickCount(chopstickCount + 1)} className="px-2.5 py-1.5 text-purple-600 font-bold text-sm active:bg-purple-50">+</button>
                                            </div>
                                        )}
                                    </div>
                                    {wantChopsticks && <p className="text-xs text-purple-500 ml-1">🥢 {chopstickCount} × $0.50 = ${(chopstickCount * 0.5).toFixed(2)}</p>}
                                    {(wantPlates || wantChopsticks) && (
                                        <div className="border-t border-gray-200 pt-2 mt-2">
                                            <p className="text-xs font-bold text-purple-700 text-right">{language === "es" ? "Total Cubiertos" : "Utensils Total"}: ${getUtensilCost().toFixed(2)}</p>
                                        </div>
                                    )}
                                </div>
                            </div>
                            {CATERING_MENU.map((cat, catIdx) => (
                                <div key={catIdx} className="mb-6">
                                    <h3 className="text-lg font-bold text-gray-800 mb-3 border-b-2 border-mint-200 pb-1">
                                        {cat.emoji} {language === "es" ? cat.categoryEs : cat.category}
                                    </h3>
                                    {cat.items.map((item, itemIdx) => (
                                        <CateringMenuItem key={itemIdx} item={item} language={language} onAdd={addToCart} />
                                    ))}
                                </div>
                            ))}
                            <div className="mb-6">
                                <h3 className="text-lg font-bold text-gray-800 mb-3 border-b-2 border-mint-200 pb-1">
                                    ✏️ {language === "es" ? "Artículo Personalizado" : "Custom Item"}
                                </h3>
                                <div onClick={() => setCustomItemOpen(!customItemOpen)}
                                    className="flex justify-between items-center bg-white border-2 border-gray-200 rounded-lg p-3 mb-2 cursor-pointer active:bg-gray-50">
                                    <div>
                                        <p className="font-bold text-gray-800 text-sm">{language === "es" ? "Agregar Artículo Abierto" : "Add Open Item"}</p>
                                        <p className="text-xs text-gray-400">{language === "es" ? "Escriba nombre y precio" : "Enter any item name & price"}</p>
                                    </div>
                                    <span className="text-lg text-mint-700 font-bold">{customItemOpen ? "−" : "+"}</span>
                                </div>
                                {customItemOpen && (
                                    <div className="bg-mint-50 border-2 border-mint-200 rounded-lg p-3 mb-2">
                                        <div className="mb-2">
                                            <label className="block text-xs font-bold text-gray-600 mb-1">{language === "es" ? "Nombre del Artículo" : "Item Name"} *</label>
                                            <input value={customItemName} onChange={e => setCustomItemName(e.target.value)}
                                                className="w-full border-2 border-gray-200 rounded-lg px-3 py-2.5 text-sm bg-white"
                                                placeholder={language === "es" ? "Ej: Bandeja extra de arroz" : "Ex: Extra rice tray"} />
                                        </div>
                                        <div className="flex gap-2 mb-2">
                                            <div className="flex-1">
                                                <label className="block text-xs font-bold text-gray-600 mb-1">{language === "es" ? "Precio" : "Price"} ($) *</label>
                                                <input value={customItemPrice} onChange={e => setCustomItemPrice(e.target.value)}
                                                    type="number" min="0" step="0.01"
                                                    className="w-full border-2 border-gray-200 rounded-lg px-3 py-2.5 text-sm bg-white"
                                                    placeholder="0.00" />
                                            </div>
                                            <div className="w-20">
                                                <label className="block text-xs font-bold text-gray-600 mb-1">Qty</label>
                                                <div className="flex items-center border-2 border-gray-200 rounded-lg bg-white">
                                                    <button onClick={() => setCustomItemQty(Math.max(1, customItemQty - 1))} className="px-2 py-2 text-gray-500 font-bold">−</button>
                                                    <span className="flex-1 text-center text-sm font-bold">{customItemQty}</span>
                                                    <button onClick={() => setCustomItemQty(customItemQty + 1)} className="px-2 py-2 text-gray-500 font-bold">+</button>
                                                </div>
                                            </div>
                                        </div>
                                        <div className="mb-3">
                                            <label className="block text-xs font-bold text-gray-600 mb-1">{language === "es" ? "Nota" : "Note"}</label>
                                            <input value={customItemNote} onChange={e => setCustomItemNote(e.target.value)}
                                                className="w-full border-2 border-gray-200 rounded-lg px-3 py-2.5 text-sm bg-white"
                                                placeholder={language === "es" ? "Opcional" : "Optional"} />
                                        </div>
                                        <button onClick={addCustomItem}
                                            disabled={!customItemName.trim() || !customItemPrice}
                                            className={`w-full py-2.5 rounded-lg font-bold text-sm ${customItemName.trim() && customItemPrice ? "bg-mint-700 text-white" : "bg-gray-200 text-gray-400"}`}>
                                            + {language === "es" ? "Agregar al Pedido" : "Add to Order"} {customItemPrice ? "— $" + (parseFloat(customItemPrice) * customItemQty).toFixed(2) : ""}
                                        </button>
                                    </div>
                                )}
                            </div>
                            <div className="flex gap-2 mt-4">
                                <button onClick={() => setStep(1)} className="flex-1 bg-gray-100 text-gray-600 py-3 rounded-lg font-bold">← {language === "es" ? "Cliente" : "Customer"}</button>
                                <button onClick={() => setStep(3)} className="flex-1 bg-mint-700 text-white py-3 rounded-lg font-bold" disabled={cart.length === 0}>
                                    {language === "es" ? "Resumen" : "Summary"} → ({cart.length})
                                </button>
                            </div>
                        </div>
                    )}
                    {/* Step 3: Order Summary */}
                    {step === 3 && (
                        <div>
                            <div className="bg-gray-50 border-2 border-gray-200 rounded-lg p-3 mb-4">
                                <div className="flex justify-between items-start">
                                    <div>
                                        <p className="font-bold text-gray-800">{customer.name}</p>
                                        <p className="text-xs text-gray-500">{customer.phone} • {customer.email}</p>
                                        <p className="text-xs text-gray-500">{customer.date} @ {customer.time} — {customer.guests} {language === "es" ? "personas" : "guests"}</p>
                                        <p className="text-xs text-gray-500">🏪 {customer.pickupLocation === "maryland" ? "Maryland Heights" : "Webster"} — {customer.orderType === "pickup" ? (language === "es" ? "Recogida" : "Pickup") : "🚗 " + (language === "es" ? "Entrega" : "Delivery")}</p>
                                        {customer.orderType === "delivery" && <p className="text-xs text-gray-500">📍 {customer.address}</p>}
                                    </div>
                                    <button onClick={() => setStep(1)} className="text-xs text-mint-700 font-bold">✏️ {language === "es" ? "Editar" : "Edit"}</button>
                                </div>
                            </div>
                            <h3 className="font-bold text-gray-800 mb-2">{language === "es" ? "Artículos del Pedido" : "Order Items"}</h3>
                            {cart.length === 0 && <p className="text-gray-400 text-center py-4">{language === "es" ? "Sin artículos" : "No items"}</p>}
                            {cart.map((item) => (
                                <div key={item.id} className="flex justify-between items-start bg-white border border-gray-200 rounded-lg p-3 mb-2">
                                    <div className="flex-1">
                                        <p className="font-bold text-sm text-gray-800">{item.isCustom && "✏️ "}{item.qty}x {item.name}</p>
                                        {item.size !== "Custom" && <p className="text-xs text-gray-500">{item.size}</p>}
                                        {item.type && <p className="text-xs text-gray-400">{language === "es" ? "Tipo" : "Type"}: {item.type}</p>}
                                        {item.proteins?.length > 0 && <p className="text-xs text-gray-400">{language === "es" ? "Proteínas" : "Proteins"}: {item.proteins.join(", ")}</p>}
                                        {item.sauces?.length > 0 && <p className="text-xs text-gray-400">{language === "es" ? "Salsas" : "Sauces"}: {item.sauces.join(", ")}</p>}
                                        {item.singleSauce && <p className="text-xs text-gray-400">{language === "es" ? "Salsa" : "Sauce"}: {item.singleSauce}</p>}
                                        {item.base && <p className="text-xs text-gray-400">Base: {item.base}</p>}
                                        {item.utensils && <p className="text-xs text-gray-400">{item.utensils}</p>}
                                        {item.samplerProteins && item.samplerProteins.map((sp, si) => sp.length > 0 && (
                                            <p key={si} className="text-xs text-gray-400">• {["Banh Mi", "Mini Bowls", "Rice Rolls"][si]}: {sp.join(", ")}</p>
                                        ))}
                                        {item.samplerEggRoll && <p className="text-xs text-gray-400">{language === "es" ? "Rollos" : "Egg Rolls"}: {item.samplerEggRoll}</p>}
                                        {item.itemNote && <p className="text-xs text-amber-600 italic">📝 {item.itemNote}</p>}
                                    </div>
                                    <div className="text-right ml-2">
                                        <p className="font-bold text-sm text-mint-700">${(item.price * item.qty).toFixed(2)}</p>
                                        <button onClick={() => removeFromCart(item.id)} className="text-xs text-red-500 font-bold mt-1">✕ {language === "es" ? "Quitar" : "Remove"}</button>
                                    </div>
                                </div>
                            ))}
                            <button onClick={() => setStep(2)} className="w-full border-2 border-dashed border-mint-300 text-mint-700 py-2 rounded-lg font-bold text-sm mb-4">
                                + {language === "es" ? "Agregar Más" : "Add More Items"}
                            </button>
                            <div className="mb-4">
                                <label className="block text-xs font-bold text-gray-600 mb-1">📝 {t("specialNotes", language)}</label>
                                <textarea value={specialNotes} onChange={e => setSpecialNotes(e.target.value)}
                                    className="w-full border-2 border-gray-200 rounded-lg px-3 py-2 text-sm" rows="3"
                                    placeholder={language === "es" ? "Alergias, peticiones especiales, instrucciones de entrega..." : "Allergies, special requests, delivery instructions..."} />
                            </div>
                            <div className="bg-mint-50 border-2 border-mint-200 rounded-lg p-4 mb-4">
                                <div className="flex justify-between text-sm mb-1">
                                    <span className="text-gray-600">Subtotal</span>
                                    <span className="font-bold">${getSubtotal().toFixed(2)}</span>
                                </div>
                                {getUtensilCost() > 0 && (
                                    <div className="flex justify-between text-sm mb-1">
                                        <span className="text-gray-600">🍴 {language === "es" ? "Cubiertos" : "Utensils"}
                                            <span className="text-xs text-gray-400 ml-1">
                                                ({[wantPlates ? plateCount + " " + (language === "es" ? "platos" : "plates") : "", wantChopsticks ? chopstickCount + " " + (language === "es" ? "palillos" : "chopsticks") : ""].filter(Boolean).join(", ")})
                                            </span>
                                        </span>
                                        <span className="font-bold">${getUtensilCost().toFixed(2)}</span>
                                    </div>
                                )}
                                {customer.orderType === "delivery" && (
                                    <div className="flex justify-between text-sm mb-1 items-center">
                                        <span className="text-gray-600">{language === "es" ? "Entrega" : "Delivery Fee"}</span>
                                        <div className="flex items-center gap-1">
                                            <span className="text-gray-400">$</span>
                                            <input value={deliveryFee} onChange={e => setDeliveryFee(e.target.value)}
                                                type="number" min="0" step="0.01" className="w-16 border border-mint-300 rounded px-1 py-0.5 text-sm font-bold text-right" />
                                        </div>
                                    </div>
                                )}
                                <div className="flex justify-between items-center text-sm mb-1">
                                    <div className="flex items-center gap-2">
                                        <span className={`${taxExempt ? "text-gray-400 line-through" : "text-gray-600"}`}>{language === "es" ? "Impuesto" : "Tax"} <span className="text-xs text-gray-400">({(getTaxRate() * 100).toFixed(3)}%)</span></span>
                                        <button onClick={() => setTaxExempt(!taxExempt)}
                                            className={`text-xs font-bold px-2 py-0.5 rounded-full border transition ${taxExempt ? "bg-green-100 text-green-700 border-green-300" : "bg-gray-100 text-gray-500 border-gray-200 hover:bg-gray-200"}`}>
                                            {taxExempt ? (language === "es" ? "✓ Exento" : "✓ Exempt") : (language === "es" ? "Exento" : "Exempt")}
                                        </button>
                                    </div>
                                    <span className={`font-bold ${taxExempt ? "text-gray-400 line-through" : ""}`}>${taxExempt ? "0.00" : getTax().toFixed(2)}</span>
                                </div>
                                <div className="flex justify-between text-lg font-bold border-t border-mint-300 pt-2 mt-2">
                                    <span className="text-mint-800">Total</span>
                                    <span className="text-mint-800">${getTotal().toFixed(2)}</span>
                                </div>
                            </div>
                            <button onClick={submitOrder} disabled={cart.length === 0}
                                className={`w-full py-4 rounded-lg font-bold text-lg ${cart.length > 0 ? "bg-mint-700 text-white" : "bg-gray-200 text-gray-400"}`}>
                                ✅ {editingOrderId ? (language === "es" ? "Actualizar Pedido" : "Update Order") : t("submitOrder", language)}
                            </button>
                        </div>
                    )}
                    </>
                    )}
                </div>
            );
        }
