import { useState, useEffect } from 'react';
import { db } from '../firebase';
import { doc, onSnapshot, setDoc } from 'firebase/firestore';
import { t } from '../data/translations';
import { isAdmin } from '../data/staff';

const RECIPE_PASSWORD = "ZhongGuo87";

function RecipeForm({ language, recipe, onSave, onCancel }) {
    const isEdit = !!recipe;
    const [form, setForm] = useState(recipe || {
        titleEn: "", titleEs: "", emoji: "🍽️", category: "",
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
                    <button onClick={() => removeListItem(field, i)} className="text-red-400 text-sm px-1">✕</button>
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
                    <h3 className="font-bold text-sm text-amber-800 mb-2">📝 {t("ingredients", language)}</h3>
                    {renderListEditor("ingredientsEn", language === "es" ? "Inglés" : "English")}
                    {renderListEditor("ingredientsEs", language === "es" ? "Español" : "Spanish")}
                </div>

                <div className="border-t pt-3 mt-3">
                    <h3 className="font-bold text-sm text-amber-800 mb-2">👨‍🍳 {t("instructions", language)}</h3>
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

export default function Recipes({ language, staffName, staffList }) {
    const [expandedRecipe, setExpandedRecipe] = useState(null);
    const [recipes, setRecipes] = useState([]);
    const [editMode, setEditMode] = useState(null); // null | "add" | recipe object
    const [unlocked, setUnlocked] = useState(false);
    const [recipeMultipliers, setRecipeMultipliers] = useState({}); // { recipeId: number }

    // Scale ingredient quantities
    const scaleIngredient = (text, multiplier) => {
        if (!multiplier || multiplier === 1) return text;
        // Match leading fractions, decimals, or whole numbers (with optional fraction after)
        return text.replace(/^(\d+\s+\d+\/\d+|\d+\/\d+|\d+\.?\d*)/, (match) => {
            let num;
            if (match.includes(" ") && match.includes("/")) {
                // Mixed number like "1 1/2"
                const parts = match.split(" ");
                const whole = parseFloat(parts[0]);
                const [n, d] = parts[1].split("/").map(Number);
                num = whole + n / d;
            } else if (match.includes("/")) {
                // Fraction like "1/2"
                const [n, d] = match.split("/").map(Number);
                num = n / d;
            } else {
                num = parseFloat(match);
            }
            const scaled = num * multiplier;
            // Format nicely
            if (scaled === Math.floor(scaled)) return scaled.toString();
            // Check for clean fractions
            const fracs = [[0.25, "1/4"], [0.333, "1/3"], [0.5, "1/2"], [0.667, "2/3"], [0.75, "3/4"]];
            const whole = Math.floor(scaled);
            const dec = scaled - whole;
            for (const [val, str] of fracs) {
                if (Math.abs(dec - val) < 0.05) return whole > 0 ? `${whole} ${str}` : str;
            }
            return scaled % 1 === 0 ? scaled.toString() : scaled.toFixed(1);
        });
    };
    const [showPasswordPrompt, setShowPasswordPrompt] = useState(false);
    const [pendingAction, setPendingAction] = useState(null); // "add" | recipe object
    const [passwordInput, setPasswordInput] = useState("");
    const [passwordError, setPasswordError] = useState(false);
    const adminUser = isAdmin(staffName);
    const currentStaffRecord = (staffList || []).find(s => s.name === staffName);
    const hasRecipesAccess = adminUser || (currentStaffRecord && currentStaffRecord.recipesAccess === true);

    // Load recipes from Firestore
    useEffect(() => {
        const unsubscribe = onSnapshot(doc(db, "config", "recipes"), (docSnapshot) => {
            if (docSnapshot.exists() && docSnapshot.data().list && docSnapshot.data().list.length > 0) {
                setRecipes(docSnapshot.data().list);
            }
        });
        return () => unsubscribe();
    }, []);

    const requestEdit = (action) => {
        if (unlocked) {
            setEditMode(action);
        } else {
            setPendingAction(action);
            setShowPasswordPrompt(true);
            setPasswordInput("");
            setPasswordError(false);
        }
    };

    const checkPassword = () => {
        if (passwordInput === RECIPE_PASSWORD) {
            setUnlocked(true);
            setShowPasswordPrompt(false);
            setPasswordError(false);
            if (pendingAction && pendingAction.action === "delete") {
                deleteRecipe(pendingAction.id);
            } else {
                setEditMode(pendingAction);
            }
            setPendingAction(null);
        } else {
            setPasswordError(true);
        }
    };

    const saveRecipe = async (recipeData) => {
        let updated;
        if (editMode === "add") {
            const newId = recipes.length > 0 ? Math.max(...recipes.map(r => r.id || 0)) + 1 : 1;
            updated = [...recipes, { ...recipeData, id: newId }];
        } else {
            updated = recipes.map(r => r.id === editMode.id ? { ...recipeData, id: editMode.id } : r);
        }
        setRecipes(updated);
        setEditMode(null);
        try {
            await setDoc(doc(db, "config", "recipes"), { list: updated, updatedAt: new Date().toISOString() });
        } catch (err) { console.error("Error saving recipes:", err); }
    };

    const deleteRecipe = async (recipeId) => {
        if (!confirm(language === "es" ? "¿Eliminar esta receta?" : "Delete this recipe?")) return;
        const updated = recipes.filter(r => r.id !== recipeId);
        setRecipes(updated);
        try {
            await setDoc(doc(db, "config", "recipes"), { list: updated, updatedAt: new Date().toISOString() });
        } catch (err) { console.error("Error deleting recipe:", err); }
    };

    // Access gate — block staff without recipesAccess
    if (!hasRecipesAccess) {
        return (
            <div className="p-4 pb-24">
                <div className="max-w-sm mx-auto mt-16 text-center">
                    <div className="text-6xl mb-4">{"\u{1F512}"}</div>
                    <h2 className="text-xl font-bold text-gray-800 mb-2">
                        {language === "es" ? "Acceso Restringido" : "Access Restricted"}
                    </h2>
                    <p className="text-gray-500 text-sm">
                        {language === "es"
                            ? "No tienes acceso a las recetas. Contacta a un administrador para obtener permiso."
                            : "You don't have access to recipes. Contact an admin to get permission."}
                    </p>
                </div>
            </div>
        );
    }

    // Password prompt modal
    if (showPasswordPrompt) {
        return (
            <div className="p-4 pb-24">
                <div className="max-w-sm mx-auto mt-12 bg-white border-2 border-amber-300 rounded-xl p-6 shadow-lg">
                    <div className="text-center mb-4">
                        <span className="text-4xl">🔐</span>
                        <h3 className="font-bold text-lg text-gray-800 mt-2">{language === "es" ? "Contraseña de Recetas" : "Recipe Password"}</h3>
                        <p className="text-xs text-gray-500 mt-1">{language === "es" ? "Ingrese la contraseña para editar recetas" : "Enter password to edit recipes"}</p>
                    </div>
                    <input
                        type="password"
                        className={`w-full border-2 ${passwordError ? "border-red-400" : "border-gray-300"} rounded-lg px-4 py-3 text-center text-lg mb-2`}
                        value={passwordInput}
                        onChange={e => { setPasswordInput(e.target.value); setPasswordError(false); }}
                        onKeyDown={e => e.key === "Enter" && checkPassword()}
                        placeholder="••••••••"
                        autoFocus
                    />
                    {passwordError && <p className="text-red-500 text-xs text-center mb-2">{language === "es" ? "Contraseña incorrecta" : "Incorrect password"}</p>}
                    <div className="flex gap-2 mt-3">
                        <button onClick={() => { setShowPasswordPrompt(false); setPendingAction(null); }} className="flex-1 border border-gray-300 rounded-lg py-2 text-sm text-gray-600">{language === "es" ? "Cancelar" : "Cancel"}</button>
                        <button onClick={checkPassword} className="flex-1 bg-mint-700 text-white rounded-lg py-2 text-sm font-bold">{language === "es" ? "Entrar" : "Enter"}</button>
                    </div>
                </div>
            </div>
        );
    }

    // Edit/Add form
    // Screenshot protection — blur recipes when app loses focus
    const [screenBlurred, setScreenBlurred] = useState(false);
    useEffect(() => {
        const handleVisChange = () => {
            if (document.hidden) setScreenBlurred(true);
            else setTimeout(() => setScreenBlurred(false), 300);
        };
        const handleBlur = () => setScreenBlurred(true);
        const handleFocus = () => setTimeout(() => setScreenBlurred(false), 300);
        document.addEventListener('visibilitychange', handleVisChange);
        window.addEventListener('blur', handleBlur);
        window.addEventListener('focus', handleFocus);
        return () => {
            document.removeEventListener('visibilitychange', handleVisChange);
            window.removeEventListener('blur', handleBlur);
            window.removeEventListener('focus', handleFocus);
        };
    }, []);

    if (editMode) {
        return <RecipeForm
            language={language}
            recipe={editMode === "add" ? null : editMode}
            onSave={saveRecipe}
            onCancel={() => setEditMode(null)}
        />;
    }

    return (
        <div className={`p-4 pb-24 recipe-protected ${screenBlurred ? "screen-blur" : ""}`} onContextMenu={e => e.preventDefault()}>
            <div className="flex items-center justify-between mb-2">
                <h2 className="text-2xl font-bold text-mint-700">🧑‍🍳 {t("recipesTitle", language)}</h2>
                {adminUser && (
                    <button
                        onClick={() => requestEdit("add")}
                        className="bg-mint-700 text-white px-3 py-1.5 rounded-lg text-sm font-bold flex items-center gap-1"
                    >
                        + {language === "es" ? "Agregar" : "Add"}
                    </button>
                )}
            </div>
            <p className="text-xs text-gray-500 mb-4 bg-red-50 border border-red-200 rounded-lg p-2">
                🔒 {language === "es"
                    ? "CONFIDENCIAL — Estas recetas son propiedad de DD Mau. No tomes capturas de pantalla, fotos ni compartas fuera del restaurante. Tu nombre está registrado en cada vista."
                    : "CONFIDENTIAL — These recipes are DD Mau property. Do not screenshot, photograph, or share outside the restaurant. Your name is logged on every view."}
            </p>

            {recipes.map(recipe => {
                const isExpanded = expandedRecipe === recipe.id;
                return (
                    <div key={recipe.id} className="mb-3 bg-white rounded-lg border-2 border-gray-200 overflow-hidden">
                        <div
                            className="p-4 cursor-pointer bg-gradient-to-r from-amber-50 to-white"
                            onClick={() => setExpandedRecipe(isExpanded ? null : recipe.id)}
                        >
                            <div className="flex items-center justify-between">
                                <div className="flex items-center gap-3">
                                    <span className="text-3xl">{recipe.emoji}</span>
                                    <div>
                                        <h3 className="font-bold text-amber-800">
                                            {language === "es" ? (recipe.titleEs || recipe.titleEn) : recipe.titleEn}
                                        </h3>
                                        <p className="text-xs text-gray-500">{recipe.category}</p>
                                    </div>
                                </div>
                                <span className={`text-lg transition-transform ${isExpanded ? "rotate-180" : ""}`}>▼</span>
                            </div>
                        </div>

                        {isExpanded && (
                            <div className="border-t border-gray-200 p-4 recipe-watermark overflow-hidden" data-watermark={staffName}>
                                {adminUser && (
                                    <div className="flex gap-2 mb-3">
                                        <button onClick={(e) => { e.stopPropagation(); requestEdit(recipe); }} className="text-xs bg-amber-100 text-amber-700 px-3 py-1 rounded-full font-bold border border-amber-300">
                                            ✏️ {language === "es" ? "Editar" : "Edit"}
                                        </button>
                                        <button onClick={(e) => { e.stopPropagation(); if(unlocked) deleteRecipe(recipe.id); else { setPendingAction({action:"delete", id: recipe.id}); setShowPasswordPrompt(true); setPasswordInput(""); setPasswordError(false); }}} className="text-xs bg-red-50 text-red-600 px-3 py-1 rounded-full font-bold border border-red-200">
                                            🗑️ {language === "es" ? "Eliminar" : "Delete"}
                                        </button>
                                    </div>
                                )}
                                <div className="flex gap-4 mb-4 text-xs">
                                    <div className="bg-blue-50 rounded-lg px-3 py-2 flex-1 text-center">
                                        <div className="font-bold text-blue-700">{t("prepTime", language)}</div>
                                        <div className="text-blue-600">{recipe.prepTimeEn}</div>
                                    </div>
                                    <div className="bg-orange-50 rounded-lg px-3 py-2 flex-1 text-center">
                                        <div className="font-bold text-orange-700">{t("cookTime", language)}</div>
                                        <div className="text-orange-600">{recipe.cookTimeEn}</div>
                                    </div>
                                    <div className="bg-green-50 rounded-lg px-3 py-2 flex-1 text-center">
                                        <div className="font-bold text-green-700">{t("yields", language)}</div>
                                        <div className="text-green-600">{(() => {
                                            const mult = recipeMultipliers[recipe.id] || 1;
                                            const yieldText = language === "es" ? (recipe.yieldsEs || recipe.yieldsEn) : recipe.yieldsEn;
                                            return mult === 1 ? yieldText : scaleIngredient(yieldText, mult);
                                        })()}</div>
                                    </div>
                                </div>

                                {/* Recipe Multiplier */}
                                <div className="mb-4 bg-purple-50 rounded-lg p-3 border border-purple-200">
                                    <div className="text-xs font-bold text-purple-700 mb-2">🔢 {language === "es" ? "Multiplicador de Receta" : "Recipe Multiplier"}</div>
                                    <div className="flex items-center gap-2 flex-wrap">
                                        {[{label: "½x", val: 0.5}, {label: "1x", val: 1}, {label: "2x", val: 2}, {label: "3x", val: 3}, {label: "5x", val: 5}, {label: "10x", val: 10}].map(btn => {
                                            const current = recipeMultipliers[recipe.id] || 1;
                                            const isActive = current === btn.val;
                                            return (
                                                <button
                                                    key={btn.val}
                                                    onClick={() => setRecipeMultipliers(prev => ({...prev, [recipe.id]: btn.val}))}
                                                    className={`px-3 py-1.5 rounded-full text-xs font-bold border transition-all ${isActive ? "bg-purple-600 text-white border-purple-600 shadow-md" : "bg-white text-purple-700 border-purple-300 hover:bg-purple-100"}`}
                                                >
                                                    {btn.label}
                                                </button>
                                            );
                                        })}
                                        <div className="flex items-center gap-1 ml-1">
                                            <input
                                                type="number"
                                                min="0.1"
                                                step="0.1"
                                                placeholder={language === "es" ? "Otro" : "Custom"}
                                                value={(() => {
                                                    const cur = recipeMultipliers[recipe.id] || 1;
                                                    const presets = [0.5, 1, 2, 3, 5, 10];
                                                    return presets.includes(cur) ? "" : cur;
                                                })()}
                                                onChange={(e) => {
                                                    const v = parseFloat(e.target.value);
                                                    if (v > 0) setRecipeMultipliers(prev => ({...prev, [recipe.id]: v}));
                                                }}
                                                className="w-16 text-center border border-purple-300 rounded-lg px-2 py-1.5 text-xs font-bold text-purple-700 focus:outline-none focus:ring-2 focus:ring-purple-400"
                                            />
                                            <span className="text-xs text-purple-500 font-bold">x</span>
                                        </div>
                                    </div>
                                    {(recipeMultipliers[recipe.id] && recipeMultipliers[recipe.id] !== 1) && (
                                        <div className="mt-2 text-xs text-purple-600 font-medium">
                                            📐 {language === "es"
                                                ? `Mostrando cantidades para ${recipeMultipliers[recipe.id]}x la receta`
                                                : `Showing quantities for ${recipeMultipliers[recipe.id]}x the recipe`}
                                        </div>
                                    )}
                                </div>

                                <div className="mb-4">
                                    <h4 className="font-bold text-sm text-gray-800 mb-2 border-b pb-1">📝 {t("ingredients", language)}</h4>
                                    <ul className="space-y-1">
                                        {(language === "es" ? (recipe.ingredientsEs || recipe.ingredientsEn) : recipe.ingredientsEn).map((item, i) => {
                                            const mult = recipeMultipliers[recipe.id] || 1;
                                            const displayItem = scaleIngredient(item, mult);
                                            return (
                                                <li key={i} className="text-sm text-gray-700 flex items-start gap-2">
                                                    <span className="text-mint-400 mt-1">•</span>
                                                    <span>{displayItem}</span>
                                                </li>
                                            );
                                        })}
                                    </ul>
                                </div>

                                <div>
                                    <h4 className="font-bold text-sm text-gray-800 mb-2 border-b pb-1">👨‍🍳 {t("instructions", language)}</h4>
                                    <ol className="space-y-2">
                                        {(language === "es" ? (recipe.instructionsEs || recipe.instructionsEn) : recipe.instructionsEn).map((step, i) => (
                                            <li key={i} className="text-sm text-gray-700 flex items-start gap-2">
                                                <span className="bg-mint-700 text-white rounded-full w-5 h-5 flex items-center justify-center text-xs font-bold flex-shrink-0 mt-0.5">{i + 1}</span>
                                                <span>{step}</span>
                                            </li>
                                        ))}
                                    </ol>
                                </div>
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
}
