import { useState } from 'react';
import { t } from '../data/translations';
import { MENU_DATA } from '../data/menu';
import {
    BUILD_SHEET_BOWLS,
    BUILD_SHEET_HANDHELDS,
    BUILD_SHEET_FRIED_RICE,
    BUILD_SHEET_PHO,
    BUILD_SHEET_SAUCES,
    BUILD_SHEET_SNACKS,
} from '../data/buildSheet';

export default function MenuReference({ language }) {
    const [expandedCategory, setExpandedCategory] = useState(null);
    const [view, setView] = useState("menu"); // "menu" | "build"
    const isEs = language === "es";

    return (
        <div className="p-4 pb-bottom-nav">
            <h2 className="text-2xl font-bold text-mint-700 mb-1">🍜 {t("menuReference", language)}</h2>
            <p className="text-xs text-gray-500 mb-3">
                {isEs
                    ? "Para alergias graves siempre confirma con el líder y la cocina. Ver la Matriz de Alérgenos en Entrenamiento M17."
                    : "For serious allergies, always confirm with the Shift Lead and kitchen. See the Allergen Matrix in Training M17."}
            </p>

            {/* View toggle: customer menu vs cashier build sheet */}
            <div className="grid grid-cols-2 gap-2 mb-4">
                <button onClick={() => setView("menu")}
                    className={`py-2 rounded-lg text-sm font-bold border-2 ${view === "menu" ? "bg-mint-700 text-white border-mint-700" : "bg-white text-gray-700 border-gray-300"}`}>
                    🍜 {isEs ? "Menú (precios)" : "Menu (prices)"}
                </button>
                <button onClick={() => setView("build")}
                    className={`py-2 rounded-lg text-sm font-bold border-2 ${view === "build" ? "bg-mint-700 text-white border-mint-700" : "bg-white text-gray-700 border-gray-300"}`}>
                    📋 {isEs ? "Build Sheet" : "Build Sheet"}
                </button>
            </div>

            {view === "build" && <BuildSheetView isEs={isEs} />}

            {view === "menu" && (
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
            )}
        </div>
    );
}

// ── Build Sheet ───────────────────────────────────────────────────────
// What's IN every menu item — toppings, default sauces, piece counts,
// combo definitions, pho proteins. Sourced from the laminated cashier
// training pages. Bilingual.
function BuildSheetView({ isEs }) {
    const tx = (en, es) => (isEs ? es : en);
    const card = (extraClass = "") => `bg-white rounded-lg border-2 border-gray-200 p-3 ${extraClass}`;

    // Generic renderer for the bowl/handheld build cards.
    const ItemBuildCard = ({ item }) => (
        <div className={card()}>
            <h4 className="font-bold text-mint-700 text-base">{tx(item.nameEn, item.nameEs || item.nameEn)}</h4>
            {(item.baseEn || item.baseEs) && (
                <p className="text-[11px] italic text-gray-500 mb-2">{tx(item.baseEn, item.baseEs || item.baseEn)}</p>
            )}
            {item.standardToppings && item.standardToppings.length > 0 && (
                <div className="mb-2">
                    <p className="text-[10px] font-bold uppercase text-gray-500 mb-1">{tx("Standard build", "Build estándar")}</p>
                    <ul className="text-xs text-gray-800 space-y-0.5">
                        {item.standardToppings.map((tp, i) => (
                            <li key={i}>• {tx(tp.en, tp.es || tp.en)}</li>
                        ))}
                    </ul>
                </div>
            )}
            {item.notes && item.notes.length > 0 && (
                <ul className="text-[11px] text-gray-700 space-y-1 border-t border-gray-100 pt-2">
                    {item.notes.map((n, i) => (
                        <li key={i}>★ {tx(n.en, n.es || n.en)}</li>
                    ))}
                </ul>
            )}
            {item.piecesByProtein && Object.keys(item.piecesByProtein).length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                    {Object.entries(item.piecesByProtein).map(([k, v]) => (
                        <span key={k} className="text-[10px] font-bold bg-blue-100 text-blue-800 px-1.5 py-0.5 rounded">
                            {k}: {v}
                        </span>
                    ))}
                </div>
            )}
        </div>
    );

    return (
        <div className="space-y-4">
            {/* Bowls */}
            <section>
                <h3 className="text-sm font-bold text-gray-700 mb-2 px-1">🥗 {tx("Bowls", "Bowls")}</h3>
                <div className="space-y-2">
                    {BUILD_SHEET_BOWLS.map((it, i) => <ItemBuildCard key={i} item={it} />)}
                </div>
            </section>

            {/* Handhelds: bao, spring rolls, banh mi, tacos */}
            <section>
                <h3 className="text-sm font-bold text-gray-700 mb-2 px-1">🥪 {tx("Handhelds", "Handhelds")}</h3>
                <div className="space-y-2">
                    {BUILD_SHEET_HANDHELDS.map((it, i) => <ItemBuildCard key={i} item={it} />)}
                </div>
            </section>

            {/* Fried Rice */}
            <section>
                <h3 className="text-sm font-bold text-gray-700 mb-2 px-1">🍚 {tx("Fried Rice", "Arroz Frito")}</h3>
                <ItemBuildCard item={BUILD_SHEET_FRIED_RICE} />
            </section>

            {/* Pho */}
            <section>
                <h3 className="text-sm font-bold text-gray-700 mb-2 px-1">🍲 {tx("Pho", "Pho")}</h3>
                <div className={card()}>
                    <h4 className="font-bold text-mint-700 text-base">{tx(BUILD_SHEET_PHO.nameEn, BUILD_SHEET_PHO.nameEs)}</h4>
                    <div className="mb-2 mt-1">
                        <p className="text-[10px] font-bold uppercase text-gray-500 mb-1">{tx("Standard garnish", "Guarnición estándar")}</p>
                        <ul className="text-xs text-gray-800 space-y-0.5">
                            {BUILD_SHEET_PHO.standardToppings.map((tp, i) => (
                                <li key={i}>• {tx(tp.en, tp.es || tp.en)}</li>
                            ))}
                        </ul>
                    </div>
                    <div className="mt-3 space-y-2">
                        {BUILD_SHEET_PHO.broths.map((b, i) => (
                            <div key={i} className="bg-amber-50 border border-amber-200 rounded p-2">
                                <p className="text-xs font-bold text-amber-900">{tx(b.nameEn, b.nameEs)}</p>
                                <ul className="text-[11px] text-gray-800 mt-1 space-y-0.5">
                                    {(isEs ? b.proteinsEs : b.proteinsEn).map((p, j) => (
                                        <li key={j}>· {p}</li>
                                    ))}
                                </ul>
                            </div>
                        ))}
                    </div>
                </div>
            </section>

            {/* Sauces (cashier-friendly descriptions) */}
            <section>
                <h3 className="text-sm font-bold text-gray-700 mb-2 px-1">🥢 {tx("Sauces (cashier descriptions)", "Salsas (para describir al cliente)")}</h3>
                <div className={card()}>
                    <ul className="text-xs text-gray-800 space-y-1">
                        {BUILD_SHEET_SAUCES.map((s, i) => (
                            <li key={i}>
                                <span className="font-bold text-mint-700">{tx(s.nameEn, s.nameEs)}</span>
                                <span className="text-gray-600"> — {tx(s.descEn, s.descEs)}</span>
                            </li>
                        ))}
                    </ul>
                </div>
            </section>

            {/* Snacks */}
            <section>
                <h3 className="text-sm font-bold text-gray-700 mb-2 px-1">🥟 {tx("Snacks", "Snacks")}</h3>
                <div className={card()}>
                    <ul className="text-xs text-gray-800 space-y-1">
                        {BUILD_SHEET_SNACKS.map((s, i) => (
                            <li key={i}>
                                <span className="font-bold text-mint-700">{tx(s.nameEn, s.nameEs)}</span>
                                <span className="text-gray-600"> — {tx(s.descEn, s.descEs)}</span>
                            </li>
                        ))}
                    </ul>
                </div>
            </section>
        </div>
    );
}
