import { useState, useEffect } from 'react';
import { db } from '../firebase';
import { getDoc, doc } from 'firebase/firestore';
// 2026-08-25 audit: archived tasks RETAIN their recurrence fields, so a
// Saturdays-only task used to paint ❌ on every other weekday and inflate
// done/total. Filter with the same shared matcher the live Tasks page and
// taskPlan's checklistTasksForDay use on these very docs. weekdayOf is
// taskPlan's UTC-noon day-of-week (DST-safe on a bare YYYY-MM-DD string).
import { taskDueOnDay } from '../data/checklistRecurrence';
import { weekdayOf } from '../data/taskPlan';

const TIME_PERIODS = [{ id: "all", nameEn: "All Tasks", nameEs: "Todas las Tareas" }];

// Skip-with-reason labels — small local copy of Operations.jsx's
// SKIP_REASONS (same ids; keep in sync if a reason is ever added there).
// A skipped task is RESOLVED, not forgotten: history renders it ⏭ neutral
// (with the reason) instead of ❌, and counts it as satisfied.
const SKIP_REASON_LABELS = {
    out_of_stock:     { emoji: "🚫", en: "Out of stock",     es: "Sin existencia" },
    equipment_broken: { emoji: "🔧", en: "Equipment broken", es: "Equipo dañado" },
    no_time:          { emoji: "⏰", en: "Ran out of time",  es: "Sin tiempo" },
    not_needed:       { emoji: "✋", en: "Not needed today", es: "No se necesita hoy" },
    other:            { emoji: "❓", en: "Skipped",          es: "Omitida" },
};

// Number of calendar days back to probe for history. 30 is plenty for
// the manager flipping back through "what got done last week" while
// staying well under the 60-read-per-open cost of the earlier query.
const HISTORY_LOOKBACK_DAYS = 30;

// Today in Chicago wall-clock (where the restaurant lives), formatted
// as YYYY-MM-DD — must match the docId scheme writers use in
// Operations.jsx (getTodayKey()). Without TZ-pinning, a manager on the
// East Coast at 11pm would compute "tomorrow" and miss today's doc.
function todayCentralKey() {
    const fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Chicago',
        year: 'numeric', month: '2-digit', day: '2-digit',
    });
    return fmt.format(new Date()); // already YYYY-MM-DD
}

// Walk N days back from a YYYY-MM-DD string and return the list of
// keys, newest first. Pure date math — no TZ math past the seed key.
function lastNDayKeys(seedKey, n) {
    const [y, m, d] = seedKey.split('-').map(Number);
    const out = [];
    for (let i = 0; i < n; i++) {
        const dt = new Date(Date.UTC(y, m - 1, d - i));
        const yy = dt.getUTCFullYear();
        const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
        const dd = String(dt.getUTCDate()).padStart(2, '0');
        out.push(`${yy}-${mm}-${dd}`);
    }
    return out;
}

export default function ChecklistHistory({ language, storeLocation, timePeriods }) {
    // Use passed timePeriods or fall back to default
    const periods = timePeriods && timePeriods.length > 0 ? timePeriods : TIME_PERIODS;
    const [historyDates, setHistoryDates] = useState([]);
    const [selectedDate, setSelectedDate] = useState(null);
    const [dayData, setDayData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [historySide, setHistorySide] = useState("FOH");
    const [expandedPhoto, setExpandedPhoto] = useState(null);

    useEffect(() => {
        // 2026-05-26: switched from a list query (orderBy __name__ desc
        // limit 60) to a calendar-based parallel fetch.
        //
        // Why: the orderBy('__name__', 'desc') query was failing on the
        // live Firestore project with FAILED_PRECONDITION ("the query
        // requires an index") — even though descending __name__ is
        // typically auto-indexed. With no error UI, the whole History
        // tab silently showed empty for ~5 days. Verified against the
        // raw collection: data IS there (2026-05-24 and earlier),
        // sortable by docId.
        //
        // New approach: compute the last N day-strings client-side,
        // getDoc() each in parallel, keep the ones that exist. Both
        // bare 'YYYY-MM-DD' and '_saved' variants are checked so days
        // that have only the rollover snapshot still appear as a
        // selectable date. ~30 reads/open, same cost ceiling as the
        // old query, deterministic, no index dependency.
        const fetchHistory = async () => {
            try {
                const today = todayCentralKey();
                const keys = lastNDayKeys(today, HISTORY_LOOKBACK_DAYS);
                const reads = keys.flatMap((k) => [
                    getDoc(doc(db, "checklistHistory_" + storeLocation, k)),
                    getDoc(doc(db, "checklistHistory_" + storeLocation, k + "_saved")),
                ]);
                const results = await Promise.allSettled(reads);
                const dates = [];
                for (let i = 0; i < keys.length; i++) {
                    const bare = results[i * 2];
                    const saved = results[i * 2 + 1];
                    const exists = (bare.status === 'fulfilled' && bare.value.exists())
                                || (saved.status === 'fulfilled' && saved.value.exists());
                    if (exists) dates.push(keys[i]);
                }
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
        // Only the tasks actually DUE on the selected day (see the import
        // comment above) — the archive keeps the whole list, recurrence and
        // all, so unfiltered rendering marked not-due tasks as missed.
        const wd = weekdayOf(selectedDate);
        const tasks = (dayData.customTasks[historySide]?.[period.id] || [])
            .filter(t => taskDueOnDay(t, wd, selectedDate));
        if (tasks.length === 0) return null;
        const checks = dayData.checks || {};
        // Skip keys (Operations skipTask): `${id}_skipped` holds the reason
        // id. History reads list-0 keys (prefix ''), and subtasks can be
        // skipped individually under their own ids.
        const isSkipped = (id) => !!checks[id + "_skipped"];

        let totalItems = 0, doneItems = 0;
        tasks.forEach(task => {
            const taskSkipped = isSkipped(task.id);
            if (task.subtasks && task.subtasks.length > 0) {
                totalItems += task.subtasks.length;
                doneItems += task.subtasks.filter(s => checks[s.id] || isSkipped(s.id) || taskSkipped).length;
            } else {
                totalItems += 1;
                doneItems += (checks[task.id] || taskSkipped) ? 1 : 0;
            }
            if (task.requirePhoto) { totalItems += 1; doneItems += (checks[task.id + "_photo"] || taskSkipped) ? 1 : 0; }
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
                        // Skipped-with-reason (and not otherwise complete) —
                        // neutral ⏭ rendering, never the red ❌.
                        const taskSkipped = isSkipped(task.id) && !fullyDone;
                        const skipReason = taskSkipped
                            ? (SKIP_REASON_LABELS[checks[task.id + "_skipped"]] || SKIP_REASON_LABELS.other)
                            : null;
                        const photoUrl = checks[task.id + "_photo"];

                        return (
                            <div key={idx} className={`p-2 rounded-lg text-sm ${fullyDone ? "bg-green-50" : taskSkipped ? "bg-gray-50" : "bg-red-50"}`}>
                                <div className="flex items-center gap-2">
                                    <span className="text-base">{fullyDone ? "✅" : taskSkipped ? "⏭" : "❌"}</span>
                                    <span className={fullyDone ? "text-gray-700" : taskSkipped ? "text-gray-600" : "text-red-700 font-medium"}>
                                        {task.task.includes("\n") ? task.task.split("\n").map((line, li) => (
                                            <span key={li}>{li === 0 ? line : <><br/><span className="font-normal text-xs text-gray-500">{line}</span></>}</span>
                                        )) : task.task}
                                    </span>
                                </div>
                                {/* Skip reason + who/when + optional note */}
                                {taskSkipped && (
                                    <p className="text-[11px] text-gray-500 ml-7 mt-0.5">
                                        {skipReason.emoji} {language === "es" ? skipReason.es : skipReason.en}
                                        {checks[task.id + "_by"] ? ` · ${checks[task.id + "_by"]}${checks[task.id + "_at"] ? " — " + checks[task.id + "_at"] : ""}` : ""}
                                        {checks[task.id + "_skipNote"] ? ` · "${checks[task.id + "_skipNote"]}"` : ""}
                                    </p>
                                )}
                                {/* Top-level (no-subtasks) timestamp */}
                                {!hasSubtasks && checks[task.id] && checks[task.id + "_by"] && (
                                    <p className="text-[11px] text-green-700 ml-7 mt-0.5">
                                        ✓ {checks[task.id + "_by"]} — {checks[task.id + "_at"]}
                                    </p>
                                )}
                                {hasSubtasks && (
                                    <div className="ml-7 mt-1 space-y-0.5">
                                        {task.subtasks.map((sub, si) => {
                                            const subSkipped = !checks[sub.id] && (isSkipped(sub.id) || taskSkipped);
                                            return (
                                            <div key={si} className="text-xs">
                                                <div className="flex items-center gap-1.5">
                                                    <span>{checks[sub.id] ? "✅" : subSkipped ? "⏭" : "⬜"}</span>
                                                    <span className={checks[sub.id] ? "text-gray-600" : subSkipped ? "text-gray-500" : "text-red-600"}>{sub.task}</span>
                                                </div>
                                                {checks[sub.id] && checks[sub.id + "_by"] && (
                                                    <p className="text-[10px] text-green-700 ml-5">
                                                        {checks[sub.id + "_by"]} — {checks[sub.id + "_at"]}
                                                    </p>
                                                )}
                                            </div>
                                            );
                                        })}
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
                                            <span className={taskSkipped ? "text-xs text-gray-400" : "text-xs text-red-400 font-medium"}>📸 {language === "es" ? "Foto no tomada" : "Photo not taken"}</span>
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
                    {periods.map(p => renderHistoryPeriod(p))}
                    {periods.every(p => {
                        // Same due-that-day filter as renderHistoryPeriod, so a
                        // day whose archived tasks were all not-due reads as
                        // "no tasks" instead of rendering an empty shell.
                        const wd = weekdayOf(selectedDate);
                        const tasks = (dayData.customTasks?.[historySide]?.[p.id] || [])
                            .filter(t => taskDueOnDay(t, wd, selectedDate));
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
