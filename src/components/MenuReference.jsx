import { useState } from 'react';
import { t } from '../data/translations';
import { MENU_DATA } from '../data/menu';

export default function MenuReference({ language }) {
    const [expandedCategory, setExpandedCategory] = useState(null);
    const isEs = language === "es";

    return (
        <div className="p-4 pb-24">
            <h2 className="text-2xl font-bold text-mint-700 mb-1">🍜 {t("menuReference", language)}</h2>
            <p className="text-xs text-gray-500 mb-4">
                {isEs
                    ? "Para alergias graves siempre confirma con el líder y la cocina. Ver la Matriz de Alérgenos en Entrenamiento M17."
                    : "For serious allergies, always confirm with the Shift Lead and kitchen. See the Allergen Matrix in Training M17."}
            </p>

            <div className="space-y-3">
                {MENU_DATA.map((category, idx) => (
                    <div key={idx} className="bg-white rounded-lg border-2 border-gray-200 overflow-hidden">
                        <button
                            onClick={() => setExpandedCategory(expandedCategory === idx ? null : idx)}
                            className="w-full p-4 text-left bg-gradient-to-r from-mint-50 to-white hover:bg-mint-50 border-b flex justify-between items-center"
                        >
                            <div className="flex-1 min-w-0">
                                <h3 className="font-bold text-lg text-mint-700">
                                    {isEs ? category.categoryEs : category.category}
                                </h3>
                                {category.customizable && category.customizable.length > 0 && (
                                    <div className="flex gap-1 flex-wrap mt-1">
                                        {category.customizable.map((mod, i) => (
                                            <span key={i} className="text-[10px] font-bold bg-green-100 text-green-800 px-1.5 py-0.5 rounded-full">
                                                ✓ {mod}
                                            </span>
                                        ))}
                                    </div>
                                )}
                            </div>
                            <span className="text-xl flex-shrink-0 ml-2">{expandedCategory === idx ? "▼" : "▶"}</span>
                        </button>

                        {expandedCategory === idx && (
                            <div className="p-4 space-y-4">
                                {(category.note || category.noteEs) && (
                                    <div className="text-xs text-gray-700 bg-amber-50 border border-amber-200 rounded-lg p-3">
                                        ⓘ {isEs ? category.noteEs : category.note}
                                    </div>
                                )}
                                {category.items.map((item, itemIdx) => (
                                    <div key={itemIdx} className="pb-4 border-b last:border-b-0">
                                        <div className="flex justify-between items-start mb-1 gap-2">
                                            <div className="min-w-0 flex-1">
                                                <h4 className="font-bold text-gray-800">{item.nameEn}</h4>
                                                {item.nameVi && <p className="text-sm text-gray-600">{item.nameVi}</p>}
                                            </div>
                                            {item.price && item.price !== "—" && (
                                                <p className="font-bold text-mint-700 flex-shrink-0">{item.price}</p>
                                            )}
                                        </div>
                                        {(item.descEn || item.descEs) && (
                                            <p className="text-sm text-gray-700 mb-2">
                                                {isEs ? (item.descEs || item.descEn) : item.descEn}
                                            </p>
                                        )}
                                        <div className="flex gap-2 flex-wrap text-xs">
                                            {item.popular && (
                                                <span className="bg-mint-100 text-mint-700 px-2 py-1 rounded">
                                                    ⭐ {t("popular", language)}
                                                </span>
                                            )}
                                            {item.spicy && (
                                                <span className="bg-orange-100 text-orange-700 px-2 py-1 rounded">
                                                    🌶 {t("spicy", language)}
                                                </span>
                                            )}
                                            {item.vegan && (
                                                <span className="bg-green-100 text-green-700 px-2 py-1 rounded">
                                                    🌱 {isEs ? "Vegano" : "Vegan"}
                                                </span>
                                            )}
                                            {item.glutenFree && (
                                                <span className="bg-blue-100 text-blue-700 px-2 py-1 rounded">
                                                    🌾 {isEs ? "Sin gluten" : "Gluten-free"}
                                                </span>
                                            )}
                                            {item.allergens && (
                                                <span className="bg-yellow-100 text-yellow-800 px-2 py-1 rounded">
                                                    ⚠ {item.allergens}
                                                </span>
                                            )}
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
