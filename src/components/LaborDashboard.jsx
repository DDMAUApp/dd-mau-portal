import { useState, useEffect, useMemo } from 'react';
import { db } from '../firebase';
import { doc, collection, query, where, onSnapshot, setDoc } from 'firebase/firestore';
import { t } from '../data/translations';
import { DAYPARTS, DOW_EN, DOW_ES, aggregateSplh, fmtUSD, splhTone } from '../data/splh';

// Note: Requires Chart.js or similar for charting

// Emoji constants to avoid encoding issues
const CHART_EMOJI = String.fromCodePoint(0x1F4CA);  // bar chart
const BULB_EMOJI = String.fromCodePoint(0x1F4A1);   // light bulb
const WARN_EMOJI = String.fromCodePoint(0x26A0, 0xFE0F); // warning
const CHECK_EMOJI = String.fromCodePoint(0x2705);    // check mark
const RED_CIRCLE = String.fromCodePoint(0x1F534);    // red circle
const HOURGLASS = String.fromCodePoint(0x231B);      // hourglass

export default function LaborDashboard({ language, storeLocation }) {
    const [laborData, setLaborData] = useState(null);
    const [laborHistory, setLaborHistory] = useState([]);
    const [laborTarget, setLaborTarget] = useState(25); // default target %
    const [editingTarget, setEditingTarget] = useState(false);
    const [tempTarget, setTempTarget] = useState(25);
    // Historical data for SPLH analysis — last 4 weeks of hourly snapshots.
    // Each entry should have {date: 'YYYY-MM-DD', time: 'HH:MM', netSales,
    // totalHours} (depending on what the labor scraper writes — we tolerate
    // missing fields and just skip those entries from the SPLH math).
    const [splhHistory, setSplhHistory] = useState([]);

    // Load labor target from Firestore
    useEffect(() => {
        const unsubTarget = onSnapshot(doc(db, "config", "laborTarget"), (docSnap) => {
            if (docSnap.exists() && docSnap.data()?.target) {
                setLaborTarget(docSnap.data().target);
                setTempTarget(docSnap.data().target);
            }
        });
        return () => unsubTarget();
    }, []);

    // Listen to live labor data for current location
    useEffect(() => {
        const unsubLabor = onSnapshot(doc(db, "ops", "labor_" + storeLocation), (docSnap) => {
            if (docSnap.exists()) {
                setLaborData(docSnap.data());
            } else {
                setLaborData(null);
            }
        });
        return () => unsubLabor();
    }, [storeLocation]);

    // Listen to today's labor history (hourly snapshots).
    //
    // No server-side orderBy('timestamp'): combined with where('date', ...)
    // it requires a composite Firestore index. Without that index the
    // listener errors silently and the dashboard shows nothing — same
    // trap that bit the Tardies tracker. Sort client-side instead; the
    // dataset is at most ~24 entries (hourly snapshots for one day).
    useEffect(() => {
        const today = new Date();
        const todayKey = today.getFullYear() + "-" + String(today.getMonth() + 1).padStart(2, "0") + "-" + String(today.getDate()).padStart(2, "0");
        const unsubHistory = onSnapshot(
            query(collection(db, "laborHistory_" + storeLocation), where("date", "==", todayKey)),
            (snap) => {
                const entries = [];
                snap.forEach(doc => entries.push(doc.data()));
                entries.sort((a, b) => {
                    const ta = a.timestamp?.toMillis ? a.timestamp.toMillis() : (a.timestamp || 0);
                    const tb = b.timestamp?.toMillis ? b.timestamp.toMillis() : (b.timestamp || 0);
                    return ta - tb;
                });
                setLaborHistory(entries);
            },
            (err) => { console.error("Labor history snapshot error:", err); }
        );
        return () => unsubHistory();
    }, [storeLocation]);

    // Pull last 28 days of laborHistory for SPLH analysis. Server-side
    // date range filter so we don't fetch the entire collection.
    useEffect(() => {
        const cutoff = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000);
        const cutoffKey = cutoff.getFullYear() + "-" + String(cutoff.getMonth() + 1).padStart(2, "0") + "-" + String(cutoff.getDate()).padStart(2, "0");
        const unsub = onSnapshot(
            query(collection(db, "laborHistory_" + storeLocation), where("date", ">=", cutoffKey)),
            (snap) => {
                const arr = [];
                snap.forEach(doc => arr.push(doc.data()));
                setSplhHistory(arr);
            },
            (err) => { console.warn("SPLH history snapshot error:", err); }
        );
        return () => unsub();
    }, [storeLocation]);

    // Aggregation now lives in src/data/splh.js so Schedule's advisor uses
    // the exact same math.
    const splhGrid = useMemo(() => aggregateSplh(splhHistory), [splhHistory]);
    const splhSampleCount = splhHistory.length;
    const todayDow = new Date().getDay();

    const saveTarget = async () => {
        const val = parseFloat(tempTarget);
        if (isNaN(val) || val <= 0 || val > 100) return;
        setLaborTarget(val);
        setEditingTarget(false);
        try {
            await setDoc(doc(db, "config", "laborTarget"), { target: val, updatedAt: new Date().toISOString() });
        } catch (err) { console.error("Error saving labor target:", err); }
    };

    const getStatusColor = (pct) => {
        if (pct === null || pct === undefined) return { bg: "bg-gray-100", text: "text-gray-500", ring: "ring-gray-300" };
        if (pct <= laborTarget - 3) return { bg: "bg-emerald-50", text: "text-emerald-700", ring: "ring-emerald-400", glow: "shadow-emerald-200" };
        if (pct <= laborTarget + 2) return { bg: "bg-amber-50", text: "text-amber-700", ring: "ring-amber-400", glow: "shadow-amber-200" };
        return { bg: "bg-red-50", text: "text-red-700", ring: "ring-red-400", glow: "shadow-red-200" };
    };

    const getStatusLabel = (pct) => {
        if (pct === null || pct === undefined) return "";
        if (pct <= laborTarget - 3) return t("underTarget", language);
        if (pct <= laborTarget + 2) return t("onTarget", language);
        return t("overTarget", language);
    };

    const getStatusEmoji = (pct) => {
        if (pct === null || pct === undefined) return HOURGLASS;
        if (pct <= laborTarget - 3) return CHECK_EMOJI;
        if (pct <= laborTarget + 2) return WARN_EMOJI;
        return RED_CIRCLE;
    };

    const pct = laborData?.laborPercent;
    const status = getStatusColor(pct);
    const updatedAt = laborData?.updatedAt ? new Date(laborData.updatedAt) : null;
    const minutesAgo = updatedAt ? Math.round((Date.now() - updatedAt.getTime()) / 60000) : null;
    const isStale = minutesAgo !== null && minutesAgo > 10;

    return (
        <div className="pb-bottom-nav">
            {/* Header */}
            <div className="bg-gradient-to-r from-indigo-600 to-indigo-500 text-white p-4">
                <div className="flex justify-between items-center">
                    <div>
                        <h2 className="text-xl font-bold">{t("laborDashboard", language)}</h2>
                        <p className="text-sm text-indigo-200">{t("dataFromToast", language)}</p>
                    </div>
                    <div className="text-3xl">{CHART_EMOJI}</div>
                </div>
            </div>

            <div className="p-4 space-y-4">
                {/* Main Labor % Card */}
                {laborData ? (
                    <div className={`${status.bg} rounded-2xl p-6 ring-2 ${status.ring} shadow-lg ${status.glow || ""}`}>
                        <div className="text-center">
                            <p className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-1">{t("currentLabor", language)}</p>
                            <div className="flex items-center justify-center gap-3">
                                <span className="text-6xl font-black tabular-nums" style={{color: status.text.replace("text-", "").includes("emerald") ? "#047857" : status.text.includes("amber") ? "#b45309" : "#b91c1c"}}>
                                    {pct !== null && pct !== undefined ? pct.toFixed(1) : "--"}%
                                </span>
                                <span className="text-3xl">{getStatusEmoji(pct)}</span>
                            </div>
                            <p className={`text-sm font-bold mt-1 ${status.text}`}>{getStatusLabel(pct)}</p>

                            {/* Target indicator */}
                            <div className="mt-4 flex items-center justify-center gap-2">
                                <span className="text-xs text-gray-500">{t("target", language)}:</span>
                                {editingTarget ? (
                                    <div className="flex items-center gap-1">
                                        <input type="number" value={tempTarget} onChange={(e) => setTempTarget(e.target.value)}
                                            className="w-16 px-2 py-0.5 text-sm border rounded text-center" min="1" max="100" step="0.5" />
                                        <span className="text-xs text-gray-500">%</span>
                                        <button onClick={saveTarget} className="text-xs bg-indigo-600 text-white px-2 py-0.5 rounded font-bold">{"\u2713"}</button>
                                        <button onClick={() => { setEditingTarget(false); setTempTarget(laborTarget); }} className="text-xs bg-gray-300 text-gray-700 px-2 py-0.5 rounded font-bold">{"\u2715"}</button>
                                    </div>
                                ) : (
                                    <button onClick={() => setEditingTarget(true)} className="text-sm font-bold text-indigo-600 hover:underline">
                                        {laborTarget}%
                                    </button>
                                )}
                            </div>

                            {/* Progress bar vs target */}
                            {pct !== null && pct !== undefined && (
                                <div className="mt-3 relative">
                                    <div className="w-full h-4 bg-gray-200 rounded-full overflow-hidden">
                                        <div className="h-full rounded-full transition-all duration-500"
                                            style={{
                                                width: Math.min(pct / (laborTarget * 1.5) * 100, 100) + "%",
                                                backgroundColor: pct <= laborTarget - 3 ? "#10b981" : pct <= laborTarget + 2 ? "#f59e0b" : "#ef4444"
                                            }} />
                                    </div>
                                    {/* Target marker */}
                                    <div className="absolute top-0 h-4 border-r-2 border-gray-600"
                                        style={{ left: (laborTarget / (laborTarget * 1.5) * 100) + "%" }}>
                                        <div className="absolute -top-5 -translate-x-1/2 text-[10px] font-bold text-gray-600">{laborTarget}%</div>
                                    </div>
                                </div>
                            )}
                        </div>

                        {/* Last updated */}
                        <div className="mt-3 text-center">
                            <p className={`text-xs ${isStale ? "text-red-500 font-bold" : "text-gray-400"}`}>
                                {isStale ? WARN_EMOJI + " " : ""}
                                {t("lastUpdated", language)}: {updatedAt ? updatedAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "--"}
                                {minutesAgo !== null && minutesAgo > 0 ? ` (${minutesAgo} min ago)` : minutesAgo === 0 ? " (just now)" : ""}
                            </p>
                        </div>
                    </div>
                ) : (
                    <div className="bg-gray-50 rounded-2xl p-8 text-center ring-2 ring-gray-200">
                        <div className="text-5xl mb-3">{CHART_EMOJI}</div>
                        <p className="text-gray-500 text-sm">{t("noLaborData", language)}</p>
                        <div className="mt-4 flex justify-center">
                            <div className="animate-pulse flex gap-1">
                                <div className="w-2 h-2 bg-indigo-400 rounded-full"></div>
                                <div className="w-2 h-2 bg-indigo-400 rounded-full" style={{animationDelay: "0.2s"}}></div>
                                <div className="w-2 h-2 bg-indigo-400 rounded-full" style={{animationDelay: "0.4s"}}></div>
                            </div>
                        </div>
                    </div>
                )}

                {/* Today's Trend (if history exists) */}
                {laborHistory.length > 1 && (
                    <div className="bg-white rounded-2xl p-4 ring-1 ring-gray-200 shadow-sm">
                        <h3 className="text-sm font-bold text-gray-700 mb-3">{t("laborHistory", language)}</h3>
                        <div className="flex items-end gap-1" style={{height: "120px"}}>
                            {laborHistory.map((entry, idx) => {
                                const maxPct = Math.max(...laborHistory.map(e => e.laborPercent || 0), laborTarget * 1.3);
                                const barHeight = ((entry.laborPercent || 0) / maxPct) * 100;
                                const barColor = (entry.laborPercent || 0) <= laborTarget - 3 ? "#10b981" : (entry.laborPercent || 0) <= laborTarget + 2 ? "#f59e0b" : "#ef4444";
                                const time = entry.time || "";
                                return (
                                    <div key={idx} className="flex-1 flex flex-col items-center gap-1" style={{minWidth: 0}}>
                                        <span className="text-[9px] text-gray-500 font-bold">{(entry.laborPercent || 0).toFixed(0)}%</span>
                                        <div className="w-full rounded-t" style={{height: barHeight + "%", backgroundColor: barColor, minHeight: "4px", transition: "height 0.3s ease"}} />
                                        <span className="text-[8px] text-gray-400 truncate w-full text-center">{time}</span>
                                    </div>
                                );
                            })}
                        </div>
                        {/* Target line label */}
                        <div className="flex justify-end mt-1">
                            <span className="text-[10px] text-gray-400">--- {t("target", language)}: {laborTarget}%</span>
                        </div>
                    </div>
                )}

                {/* \u2500\u2500 Historical SPLH grid (sales per labor hour by day-of-week + daypart)
                    The "math you've been missing." Each cell shows your typical $/labor-hour
                    for that day\u00D7daypart based on the last 4 weeks. Higher = more efficient
                    (every labor hour produces more sales). Shows N=number of days in sample
                    so you know how much to trust each cell. Today's row is highlighted. */}
                {splhSampleCount > 0 && (
                    <div className="bg-white rounded-2xl p-4 ring-1 ring-gray-200 shadow-sm">
                        <div className="flex items-center justify-between mb-1">
                            <h3 className="text-sm font-bold text-gray-700">
                                \uD83D\uDCB0 {language === "es" ? "SPLH hist\u00F3rico (Ventas / hora de trabajo)" : "Historical SPLH (Sales per Labor Hour)"}
                            </h3>
                            <span className="text-[10px] text-gray-400">
                                {language === "es" ? `\u00DAltimos 28 d\u00EDas \u00B7 ${splhSampleCount} muestras` : `Last 28 days \u00B7 ${splhSampleCount} samples`}
                            </span>
                        </div>
                        <p className="text-[10px] text-gray-500 mb-2">
                            {language === "es"
                                ? "Cada celda: d\u00F3lares de ventas por hora de mano de obra. Verde = saludable, \u00E1mbar = suave, rojo = posible exceso de personal. N = d\u00EDas en la muestra."
                                : "Each cell: dollars of sales per labor hour. Green = healthy, amber = soft, red = possibly over-staffed. N = days in sample."}
                        </p>
                        <div className="overflow-x-auto -mx-2 px-2">
                            <table className="w-full text-[11px] border-collapse">
                                <thead>
                                    <tr className="text-gray-500">
                                        <th className="text-left p-1 font-semibold">{language === "es" ? "D\u00EDa" : "Day"}</th>
                                        {DAYPARTS.map(p => (
                                            <th key={p.id} className="text-center p-1 font-semibold whitespace-nowrap">
                                                {language === "es" ? p.esLabel : p.enLabel}<br />
                                                <span className="text-[9px] font-normal text-gray-400">{p.startHr}-{p.endHr}</span>
                                            </th>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody>
                                    {[0,1,2,3,4,5,6].map(dow => {
                                        const isToday = dow === todayDow;
                                        const labels = language === "es" ? DOW_ES : DOW_EN;
                                        return (
                                            <tr key={dow} className={isToday ? 'bg-indigo-50' : ''}>
                                                <td className={`p-1 font-bold ${isToday ? 'text-indigo-700' : 'text-gray-700'}`}>
                                                    {labels[dow]}{isToday ? ' \u2022' : ''}
                                                </td>
                                                {DAYPARTS.map(p => {
                                                    const cell = splhGrid[dow]?.[p.id];
                                                    const tone = splhTone(cell?.splh);
                                                    return (
                                                        <td key={p.id} className="p-1">
                                                            <div className={`text-center rounded border ${tone}`}
                                                                title={cell ? `${fmtUSD(cell.sales)} sales / ${cell.hours.toFixed(1)} hrs \u00B7 n=${cell.n} day${cell.n === 1 ? '' : 's'}` : 'no data'}>
                                                                <div className="font-bold text-[12px] leading-tight py-0.5">
                                                                    {cell?.splh != null ? fmtUSD(cell.splh) : '\u2014'}
                                                                </div>
                                                                {cell && (
                                                                    <div className="text-[8px] text-gray-500 leading-none pb-0.5">n={cell.n}</div>
                                                                )}
                                                            </div>
                                                        </td>
                                                    );
                                                })}
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                        <p className="text-[10px] text-gray-500 mt-2">
                            {language === "es"
                                ? "Pr\u00F3xima fase: comparar tu horario publicado con SPLH hist\u00F3rico para sugerir cortes/agregar personal por daypart."
                                : "Next phase: compare your published schedule against historical SPLH to suggest cuts/adds per daypart."}
                        </p>
                    </div>
                )}

                {/* Info card */}
                <div className="bg-indigo-50 rounded-xl p-3 ring-1 ring-indigo-200">
                    <p className="text-xs text-indigo-700">
                        <span className="font-bold">{BULB_EMOJI}</span>{" "}
                        {language === "es"
                            ? "Los datos se actualizan autom\u00E1ticamente cada 1-2 minutos desde Toast POS. El % de mano de obra = costo total de mano de obra \u00F7 ventas netas."
                            : "Data updates automatically every 1-2 minutes from Toast POS. Labor % = total labor cost \u00F7 net sales."}
                    </p>
                </div>
            </div>
        </div>
    );
}
