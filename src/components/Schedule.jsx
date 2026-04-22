import { useState, useEffect } from 'react';
import { db } from '../firebase';
import { doc, onSnapshot } from 'firebase/firestore';
import { t } from '../data/translations';
import { LOCATION_LABELS } from '../data/staff';
import { SCHEDULE_DATA } from '../data/schedule';

export default function Schedule({ staffName, language, storeLocation, staffList }) {

    const [firebaseSchedule, setFirebaseSchedule] = useState(null);
    const [loading, setLoading] = useState(true);

    // Listen for schedule data from Firebase (pushed by Sling scraper)
    useEffect(() => {
        const docRef = doc(db, "ops", `schedule_${storeLocation}`);
        const unsub = onSnapshot(docRef, (snap) => {
            if (snap.exists()) {
                try {
                    const raw = snap.data();
                    const parsed = raw.data ? JSON.parse(raw.data) : null;
                    if (parsed && parsed.shifts && parsed.shifts.length > 0) {
                        setFirebaseSchedule(parsed);
                    }
                } catch (e) {
                    console.error("Failed to parse Firebase schedule:", e);
                }
            }
            setLoading(false);
        }, () => setLoading(false));
        return unsub;
    }, [storeLocation]);

    // Use Firebase schedule if available, otherwise fall back to static data
    const scheduleData = firebaseSchedule || SCHEDULE_DATA;
    const usingFirebase = !!firebaseSchedule;

    // Only filter by location when using static data (Firebase data is already per-location)
    const getStaffLocation = (name) => {
        const s = (staffList || []).find(st => st.name === name);
        return s?.location || "webster";
    };

    const filterByLocation = (entries) => {
        if (usingFirebase) return entries; // Firebase data is already per-location
        return entries.filter(e => {
            const loc = getStaffLocation(e.name);
            return loc === storeLocation || loc === "both";
        });
    };

    // Check if ANY day has schedule entries for this location
    const totalEntries = (scheduleData.shifts || []).reduce((sum, day) => sum + filterByLocation(day.schedule || []).length, 0);

    if (loading) {
        return (
            <div className="p-4 pb-24 text-center">
                <p className="text-gray-400 text-lg mt-8">{language === "es" ? "Cargando horario..." : "Loading schedule..."}</p>
            </div>
        );
    }

    return (
        <div className="p-4 pb-24">
            <h2 className="text-2xl font-bold text-mint-700 mb-2">{"\u{1F4C5}"} {t("weeklySchedule", language)}</h2>
            <p className="text-gray-600 mb-4">{scheduleData.week} {"\u{2014}"} <span className="font-bold text-mint-700">{LOCATION_LABELS[storeLocation]}</span></p>

            {totalEntries === 0 ? (
                <div className="bg-yellow-50 border-2 border-yellow-300 rounded-lg p-6 text-center">
                    <p className="text-yellow-700 font-bold text-lg mb-2">{"\u{1F4CB}"} {language === "es" ? "Horario no disponible" : "Schedule Not Available"}</p>
                    <p className="text-yellow-600 text-sm">{language === "es" ? `No hay turnos programados para ${LOCATION_LABELS[storeLocation]} esta semana.` : `No shifts have been added for ${LOCATION_LABELS[storeLocation]} this week.`}</p>
                    <p className="text-yellow-500 text-xs mt-2">{language === "es" ? "Contacta a tu gerente para m\u00E1s informaci\u00F3n." : "Contact your manager for schedule information."}</p>
                </div>
            ) : (
            <div className="space-y-4">
                {(scheduleData.shifts || []).map((day, idx) => {
                    const filteredSchedule = filterByLocation(day.schedule || []);
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
                                            {isCurrentStaff ? "\u2713 " : ""}{entry.name}
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
            )}
        </div>
    );
}
