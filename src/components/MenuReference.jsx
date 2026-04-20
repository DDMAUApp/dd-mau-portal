import { useState } from 'react';
import { t } from '../data/translations';
import { MENU_DATA } from '../data/menu';

export default function MenuReference({ language }) {
    const [expandedCategory, setExpandedCategory] = useState(null);

    return (
        <div className="p-4 pb-24">
            <h2 className="text-2xl font-bold text-mint-700 mb-4">🍜 {t("menuReference", language)}</h2>

            <div className="space-y-3">
                {MENU_DATA.map((category, idx) => (
                    <div key={idx} className="bg-white rounded-lg border-2 border-gray-200 overflow-hidden">
                        <button
                            onClick={() => setExpandedCategory(expandedCategory === idx ? null : idx)}
                            className="w-full p-4 text-left bg-gradient-to-r from-mint-50 to-white hover:bg-mint-50 border-b flex justify-between items-center"
                        >
                            <h3 className="font-bold text-lg text-mint-700">{language === "es" ? category.categoryEs : category.category}</h3>
                            <span className="text-xl">{expandedCategory === idx ? "▼" : "▶"}</span>
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
                                            {item.popular && <span className="bg-mint-100 text-mint-700 px-2 py-1 rounded">⭐ {t("popular", language)}</span>}
                                            {item.spicy && <span className="bg-orange-100 text-orange-700 px-2 py-1 rounded">🌶 {t("spicy", language)}</span>}
                                            {item.allergens && <span className="bg-yellow-100 text-yellow-700 px-2 py-1 rounded">⚠ {item.allergens}</span>}
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
