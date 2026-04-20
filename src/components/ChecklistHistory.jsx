import { useState, useEffect } from 'react';
import { db } from '../firebase';
import { collection, getDocs, getDoc, doc } from 'firebase/firestore';

// Note: Requires TIME_PERIODS to be imported or passed as prop

export default function ChecklistHistory({ language, storeLocation, timePeriods = [] }) {
    const [historyDates, setHistoryDates] = useState([]);
    const [selectedDate, setSelectedDate] = useState(null);
    const [dayData, setDayData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [historySide, setHistorySide] = useState("FOH");
    const [expandedPhoto, setExpandedPhoto] = useState(null);

    useEffect(() => {
        const fetchHistory = async () => {
            try {
                const snapshot = await getDocs(collection(db, "checklistHistory_" + storeLocation));
                const dates = snapshot.docs.map(docData => docData.id).filter(d => !d.includes("_")).sort().reverse().slice(0, 30);
                setHistoryDates(dates);
                if (dates.length > 0) setSelectedDate(dates[0]);
            } catch (err) { console.error("Error loading history:", err); }
            setLoading(false);
        };
        fetchHistory();
    }, [storeLocation]);

    useEffect(() => {
        if (!selectedDate) return;
        const fetchDay = async () => {
            try {
                // Prefer the _saved version (has completed checks before reset)
                const savedDocRef = doc(db, "checklistHistory_" + storeLocation, selectedDate + "_saved");
                const savedDoc = await getDoc(savedDocRef);
                if (savedDoc.exists()) { setDayData(savedDoc.data()); return; }
                const docRef = doc(db, "checklistHistory_" + storeLocation, selectedDate);
                const docData = await getDoc(docRef);
                if (docData.exists()) setDayData(docData.data());
                else setDayData(null);
            } catch (err) { console.error("Error loading day:", err); }
        };
        fetchDay();
    }, [selectedDate, storeLocation]);

    const formatDate = (dateStr) => {
        const d = new Date(dateStr + "T12:00:00");
        return d.toLocaleDateString(language === "es" ? "es-US" : "en-US", { weekday: "short", month: "short", day: "numeric" });
    };

    const renderHistoryPeriod = (period) => {
        if (!dayData || !dayData.customTasks) return null;
        const tasks = dayData.customTasks[historySide]?.[period.id] || [];
        if (tasks.length === 0) return null;
        const checks = dayData.checks || {};

        let totalItems = 0, doneItems = 0;
        tasks.forEach(task => {
            if (task.subtasks && task.subtasks.length > 0) {
                totalItems += task.subtasks.length;
                doneItems += task.subtasks.filter(s => checks[s.id]).length;
            } else {
                totalItems += 1;
                doneItems += checks[task.id] ? 1 : 0;
            }
            if (task.requirePhoto) { totalItems += 1; doneItems += checks[task.id + "_photo"] ? 1 : 0; }
        });

        const allDone = totalItems > 0 && doneItems === totalItems;

        return (
            <div key={period.id} className="mb-3">
                <div className="flex items-center justify-between mb-1.5">
                    <span className="text-sm font-bold text-gray-700">{period.emoji} {language === "es" ? period.nameEs : period.nameEn}</span>
                    <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${allDone ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-700"}`}>
                        {doneItems}/{totalItems}
                    </span>
                </div>
                <div className="space-y-1">
                    {tasks.map((task, idx) => {
                        const hasSubtasks = task.subtasks && task.subtasks.length > 0;
                        const taskDone = hasSubtasks
                            ? task.subtasks.every(s => checks[s.id])
                            : !!checks[task.id];
                        const photoDone = task.requirePhoto ? !!checks[task.id + "_photo"] : true;
                        const fullyDone = taskDone && photoDone;
                        const photoUrl = checks[task.id + "_photo"];

                        return (
                            <div key={idx} className={`p-2 rounded-lg text-sm ${fullyDone ? "bg-green-50" : "bg-red-50"}`}>
                                <div className="flex items-center gap-2">
                                    <span className="text-base">{fullyDone ? "✅" : "❌"}</span>
                                    <span className={fullyDone ? "text-gray-700" : "text-red-700 font-medium"}>
                                        {task.task.includes("\n") ? task.task.split("\n").map((line, li) => (
                                            <span key={li}>{li === 0 ? line : <><br/><span className="font-normal text-xs text-gray-500">{line}</span></>}</span>
                                        )) : task.task}
                                    </span>
                                </div>
                                {hasSubtasks && (
                                    <div className="ml-7 mt-1 space-y-0.5">
                                        {task.subtasks.map((sub, si) => (
                                            <div key={si} className="flex items-center gap-1.5 text-xs">
                                                <span>{checks[sub.id] ? "✅" : "⬜"}</span>
                                                <span className={checks[sub.id] ? "text-gray-600" : "text-red-600"}>{sub.task}</span>
                                            </div>
                                        ))}
                                    </div>
                                )}
                                {task.requirePhoto && (
                                    <div className="ml-7 mt-1">
                                        {photoUrl ? (
                                            <button onClick={() => setExpandedPhoto(expandedPhoto === task.id ? null : task.id)}
                                                className="text-xs font-bold text-mint-700 flex items-center gap-1">
                                                📸 {expandedPhoto === task.id
                                                    ? (language === "es" ? "Ocultar foto" : "Hide photo")
                                                    : (language === "es" ? "Ver foto" : "View photo")}
                                            </button>
                                        ) : (
                                            <span className="text-xs text-red-400 font-medium">📸 {language === "es" ? "Foto no tomada" : "Photo not taken"}</span>
                                        )}
                                        {expandedPhoto === task.id && photoUrl && (
                                            <img src={photoUrl} alt="Task photo" className="mt-1 rounded-lg border border-gray-200 max-w-full" style={{ maxHeight: "200px" }} />
                                        )}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            </div>
        );
    };

    if (loading) return <div className="text-center text-gray-500 py-4">{language === "es" ? "Cargando..." : "Loading..."}</div>;

    if (historyDates.length === 0) {
        return (
            <div className="bg-gray-50 rounded-lg p-4 text-center text-gray-500">
                <p className="text-sm">{language === "es"
                    ? "Aún no hay historial de listas. El historial comenzará a guardarse cuando el equipo use las listas."
                    : "No checklist history yet. History will start saving when the team uses the checklists."}</p>
            </div>
        );
    }

    return (
        <div>
            {/* Date picker */}
            <div className="flex gap-2 overflow-x-auto pb-2 mb-3" style={{ scrollbarWidth: "none" }}>
                {historyDates.map(date => (
                    <button key={date} onClick={() => setSelectedDate(date)}
                        className={`flex-shrink-0 px-3 py-2 rounded-lg text-xs font-bold transition ${selectedDate === date
                            ? "bg-mint-700 text-white"
                            : "bg-gray-100 text-gray-600 hover:bg-mint-50"}`}>
                        {formatDate(date)}
                    </button>
                ))}
            </div>

            {/* FOH / BOH toggle */}
            <div className="flex gap-2 mb-4">
                <button onClick={() => setHistorySide("FOH")}
                    className={`flex-1 py-2 rounded-lg text-xs font-bold transition ${historySide === "FOH" ? "bg-mint-700 text-white" : "bg-gray-100 text-gray-600"}`}>
                    FOH
                </button>
                <button onClick={() => setHistorySide("BOH")}
                    className={`flex-1 py-2 rounded-lg text-xs font-bold transition ${historySide === "BOH" ? "bg-mint-700 text-white" : "bg-gray-100 text-gray-600"}`}>
                    BOH
                </button>
            </div>

            {selectedDate && dayData && (
                <div>
                    <p className="text-xs text-gray-500 mb-3">
                        {language === "es" ? "Última actualización" : "Last updated"}: {new Date(dayData.date).toLocaleString()}
                    </p>
                    {timePeriods.map(p => renderHistoryPeriod(p))}
                    {timePeriods.every(p => {
                        const tasks = dayData.customTasks?.[historySide]?.[p.id] || [];
                        return tasks.length === 0;
                    }) && (
                        <p className="text-center text-gray-400 text-sm py-4">{language === "es" ? "Sin tareas para este lado" : "No tasks for this side"}</p>
                    )}
                </div>
            )}

            {selectedDate && !dayData && (
                <p className="text-center text-gray-400 text-sm py-4">{language === "es" ? "Sin datos para este día" : "No data for this day"}</p>
            )}
        </div>
    );
}
