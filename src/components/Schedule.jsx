import { useState, useEffect } from 'react';
import { db } from '../firebase';
import { doc, onSnapshot } from 'firebase/firestore';
import { t } from '../data/translations';
import { LOCATION_LABELS } from '../data/staff';

export default function Schedule({ staffName, language, storeLocation }) {
  const [scheduleData, setScheduleData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    setScheduleData(null);
    const docRef = doc(db, "ops", `schedule_${storeLocation}`);
    const unsub = onSnapshot(docRef, (snap) => {
      if (snap.exists()) {
        setScheduleData(snap.data());
      }
      setLoading(false);
    }, () => setLoading(false));
    return unsub;
  }, [storeLocation]);

  if (loading) {
    return (
      <div className="p-4 pb-24 text-center">
        <p className="text-gray-400 text-lg mt-8">
          {language === "es" ? "Cargando horario..." : "Loading schedule..."}
        </p>
      </div>
    );
  }

  if (!scheduleData || !scheduleData.days) {
    return (
      <div className="p-4 pb-24">
        <h2 className="text-2xl font-bold text-mint-700 mb-2">
          {"\u{1F4C5}"} {t("weeklySchedule", language)}
        </h2>
        <div className="bg-yellow-50 border-2 border-yellow-300 rounded-lg p-6 text-center">
          <p className="text-yellow-700 font-bold text-lg mb-2">
            {"\u{1F4CB}"} {language === "es" ? "Horario no disponible" : "Schedule Not Available"}
          </p>
          <p className="text-yellow-600 text-sm">
            {language === "es"
              ? `No hay datos de horario para ${LOCATION_LABELS[storeLocation]}.`
              : `No schedule data available for ${LOCATION_LABELS[storeLocation]}.`}
          </p>
          <p className="text-yellow-500 text-xs mt-2">
            {language === "es"
              ? "Contacta a tu gerente para más información."
              : "Contact your manager for schedule information."}
          </p>
        </div>
      </div>
    );
  }

  const totalShifts = scheduleData.days.reduce(
    (sum, day) => sum + (day.schedule || []).length, 0
  );

  return (
    <div className="p-4 pb-24">
      <h2 className="text-2xl font-bold text-mint-700 mb-2">
        {"\u{1F4C5}"} {t("weeklySchedule", language)}
      </h2>
      <p className="text-gray-600 mb-4">
        {scheduleData.week} {"\u{2014}"}{" "}
        <span className="font-bold text-mint-700">
          {LOCATION_LABELS[storeLocation]}
        </span>
      </p>

      {totalShifts === 0 ? (
        <div className="bg-yellow-50 border-2 border-yellow-300 rounded-lg p-6 text-center">
          <p className="text-yellow-700 font-bold text-lg mb-2">
            {"\u{1F4CB}"} {language === "es" ? "Sin turnos esta semana" : "No Shifts This Week"}
          </p>
          <p className="text-yellow-600 text-sm">
            {language === "es"
              ? `No hay turnos programados para ${LOCATION_LABELS[storeLocation]} esta semana.`
              : `No shifts scheduled for ${LOCATION_LABELS[storeLocation]} this week.`}
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {scheduleData.days.map((day, idx) => {
            const shifts = day.schedule || [];
            return (
              <div key={idx} className="bg-white rounded-lg border-2 border-gray-200 overflow-hidden">
                <div className="p-4 bg-gradient-to-r from-mint-50 to-white border-b">
                  <h3 className="font-bold text-lg text-mint-700">{day.day}</h3>
                </div>
                <div className="p-4 space-y-2">
                  {shifts.length === 0 && (
                    <p className="text-gray-400 text-sm text-center py-2">
                      {language === "es" ? "Sin turnos programados" : "No shifts scheduled"}
                    </p>
                  )}
                  {shifts.map((entry, entryIdx) => {
                    const isCurrentStaff = entry.name === staffName;
                    return (
                      <div
                        key={entryIdx}
                        className={`p-3 rounded-lg ${
                          isCurrentStaff
                            ? "bg-green-50 border-2 border-green-700"
                            : "bg-gray-50 border-2 border-gray-200"
                        }`}
                      >
                        <p className={`font-bold ${isCurrentStaff ? "text-green-700" : "text-gray-800"}`}>
                          {isCurrentStaff ? "\u2713 " : ""}
                          {entry.name}
                        </p>
                        <p className="text-sm text-gray-600">{entry.shift}</p>
                        {entry.role && (
                          <p className="text-xs text-gray-500">{entry.role}</p>
                        )}
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
