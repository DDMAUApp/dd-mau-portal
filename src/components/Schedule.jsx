import { t } from '../data/translations';
import { LOCATION_LABELS } from '../data/staff';
import { SCHEDULE_DATA } from '../data/schedule';

export default function Schedule({ staffName, language, storeLocation, staffList }) {

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
            <h2 className="text-2xl font-bold text-mint-700 mb-2">📅 {t("weeklySchedule", language)}</h2>
            <p className="text-gray-600 mb-4">{SCHEDULE_DATA.week} — <span className="font-bold text-mint-700">{LOCATION_LABELS[storeLocation]}</span></p>

            <div className="space-y-4">
                {SCHEDULE_DATA.shifts.map((day, idx) => {
                    const filteredSchedule = filterByLocation(day.schedule);
                    return (
                    <div key={idx} className="bg-white rounded-lg border-2 border-gray-200 overflow-hidden">
                        <div className="p-4 bg-gradient-to-r from-mint-50 to-white border-b">
                            <h3 className="font-bold text-lg text-mint-700">{day.day}</h3>
                            {day.note && <p className="text-xs text-orange-600 mt-1">📌 {day.note}</p>}
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
                                            {isCurrentStaff ? "✓ " : ""}{entry.name}
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
