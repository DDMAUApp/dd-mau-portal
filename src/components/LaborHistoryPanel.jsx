// LaborHistoryPanel — admin view of past days' labor %, broken out by hour.
//
// Andrew 2026-06-13: "add a labor history in the admin page so we can see
// the past days labor percentage and break that up by the hour."
//
// Data source: /laborHistory_{location}. The Toast scraper writes a row
// every ~2 minutes with { date:'YYYY-MM-DD', time:'9:04 PM', laborPercent,
// laborCost, netSales, timestamp }. Because that's ~30 rows/hour, 500 rows
// only covers ONE day — so this panel queries ONE day at a time
// (where date == selectedDay) and buckets the rows into hours, taking the
// LAST reading in each hour (the running labor % at the end of that hour).
//
// Behaviour:
//   • Collapsed by default (on-demand fetch — no reads until opened).
//   • ◀ / ▶ day stepper (can't go past today). Defaults to today.
//   • Webster / Maryland toggle (labor history is per-location; there is
//     no `_both` collection).
//   • Per-hour rows with a bar + %, color-coded vs a 25% reference.
//   • Day summary: peak %, latest %, hours with data.
//
// One-shot getDocs (not a live subscription): past days are static, and
// re-fetching on open / day / location change keeps reads minimal and
// avoids a churning listener. A manual ⟳ refresh covers "today" updates.

import { useState, useEffect, useCallback } from 'react';
import { db } from '../firebase';
import { collection, query, where, getDocs } from 'firebase/firestore';

// YYYY-MM-DD for `today + offset` days, in the device's local time (the
// restaurant runs on Central, which is what the scraper stamps too).
function dateKeyForOffset(offset) {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

// Parse the 24h hour out of a "9:04 PM" style string. Returns 0-23 or null.
function parseHour(timeStr) {
    const m = String(timeStr || '').match(/(\d+):(\d+)\s*(AM|PM)/i);
    if (!m) return null;
    let h = parseInt(m[1], 10) % 12;
    if (/PM/i.test(m[3])) h += 12;
    return h;
}

function hourLabel(h) {
    const ampm = h < 12 ? 'AM' : 'PM';
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12} ${ampm}`;
}

// Friendly date label from a YYYY-MM-DD key (parsed as local, not UTC).
function prettyDate(key, isEs) {
    const [y, m, d] = key.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    return dt.toLocaleDateString(isEs ? 'es-US' : 'en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

const TARGET_REF = 25; // color reference only; not the saved target

function barColor(pct) {
    if (pct <= TARGET_REF - 3) return '#10b981'; // green
    if (pct <= TARGET_REF + 2) return '#f59e0b'; // amber
    return '#ef4444';                            // red
}

export default function LaborHistoryPanel({ language = 'en', storeLocation = 'webster' }) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);

    const [expanded, setExpanded] = useState(false);
    // Location: labor history is per-store; 'both' has no collection, so
    // default to webster when the admin is on 'both'.
    const [loc, setLoc] = useState(storeLocation === 'maryland' ? 'maryland' : 'webster');
    const [dayOffset, setDayOffset] = useState(0); // 0 = today
    const [rows, setRows] = useState([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(false);

    const dateKey = dateKeyForOffset(dayOffset);

    const load = useCallback(async () => {
        setLoading(true);
        setError(false);
        try {
            // No orderBy here on purpose: where('date'==) + orderBy('timestamp')
            // would require a composite index per location collection. A single
            // day is bounded (~720 rows at the 2-min cadence), so we fetch the
            // day and sort client-side instead — zero index setup, works for
            // every location.
            const q = query(
                collection(db, `laborHistory_${loc}`),
                where('date', '==', dateKey),
            );
            const snap = await getDocs(q);
            const out = [];
            snap.forEach(d => out.push(d.data()));
            out.sort((a, b) => {
                const ta = a.timestamp?.seconds ?? a.timestamp?._seconds ?? 0;
                const tb = b.timestamp?.seconds ?? b.timestamp?._seconds ?? 0;
                return ta - tb;
            });
            setRows(out);
        } catch (e) {
            console.warn('laborHistory load failed:', e);
            setError(true);
            setRows([]);
        } finally {
            setLoading(false);
        }
    }, [loc, dateKey]);

    // Fetch on open and whenever day/location changes (only while open).
    useEffect(() => {
        if (!expanded) return;
        load();
    }, [expanded, load]);

    // Bucket rows into hours → last reading per hour (running labor % at
    // the end of that hour). Rows are timestamp-asc, so later overwrites.
    // Hours with effectively no sales (<= $5) are dropped: before the store
    // opens, the prep crew is clocked in with $0 in sales, which Toast
    // reports as 100% labor — a pre-open artifact, not real labor cost. The
    // $5 floor matches the same guard labor.js uses for the live tile, so
    // PEAK/LATEST reflect real operating hours instead of a fake 100% spike.
    const SALES_FLOOR = 5;
    const hourly = (() => {
        const byHour = new Map();
        for (const r of rows) {
            const h = parseHour(r.time);
            if (h == null) continue;
            byHour.set(h, r); // last row in the hour wins
        }
        return [...byHour.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([h, r]) => ({
                hour: h,
                label: hourLabel(h),
                pct: Number(r.laborPercent) || 0,
                cost: Number(r.laborCost) || 0,
                sales: Number(r.netSales) || 0,
            }))
            .filter(h => h.sales > SALES_FLOOR);
    })();

    const peak = hourly.length ? Math.max(...hourly.map(h => h.pct)) : null;
    const latest = hourly.length ? hourly[hourly.length - 1].pct : null;
    const maxBar = Math.max(peak || 0, TARGET_REF * 1.4, 1);

    return (
        <div className="mb-3">
            <button onClick={() => setExpanded(s => !s)} aria-expanded={expanded}
                className="glass-section-head tint-indigo">
                <div className="flex items-center gap-3 min-w-0">
                    <span className="glass-icon-tile" aria-hidden="true">📈</span>
                    <h3 className="font-bold text-[15px] text-dd-text">
                        {tx('Labor history (by hour)', 'Historial de mano de obra (por hora)')}
                    </h3>
                </div>
                <span className="section-chevron text-xl" aria-hidden="true">›</span>
            </button>

            {expanded && (<div className="glass-card p-4 mt-2">
                <p className="text-[11px] text-gray-500 mb-3">
                    {tx(
                        'Each past day’s labor % broken out by hour (the running labor % at the end of each hour, from Toast).',
                        'El % de mano de obra de cada día pasado desglosado por hora (el % acumulado al final de cada hora, desde Toast).',
                    )}
                </p>

                {/* Controls: location toggle + day stepper + refresh */}
                <div className="flex flex-wrap items-center gap-2 mb-3">
                    <div className="flex rounded-lg overflow-hidden border border-gray-200">
                        {['webster', 'maryland'].map(L => (
                            <button key={L} onClick={() => setLoc(L)}
                                className={`px-3 py-1.5 text-xs font-bold transition ${loc === L ? 'bg-mint-700 text-white' : 'bg-white text-gray-600 hover:bg-gray-100'}`}>
                                {L === 'webster' ? 'Webster' : (tx('MD Heights', 'MD Heights'))}
                            </button>
                        ))}
                    </div>

                    <div className="flex items-center gap-1 ml-auto">
                        <button onClick={() => setDayOffset(o => o - 1)}
                            className="w-8 h-8 rounded-lg bg-gray-100 text-gray-700 font-bold hover:bg-gray-200">{'◀'}</button>
                        <div className="px-3 py-1.5 text-xs font-bold text-gray-800 min-w-[110px] text-center">
                            {prettyDate(dateKey, isEs)}{dayOffset === 0 ? ` · ${tx('today', 'hoy')}` : ''}
                        </div>
                        <button onClick={() => setDayOffset(o => Math.min(0, o + 1))}
                            disabled={dayOffset >= 0}
                            className={`w-8 h-8 rounded-lg font-bold ${dayOffset >= 0 ? 'bg-gray-50 text-gray-300' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}>{'▶'}</button>
                        <button onClick={load} title={tx('Refresh', 'Actualizar')}
                            className="w-8 h-8 rounded-lg bg-gray-100 text-gray-700 font-bold hover:bg-gray-200 ml-1">{'⟳'}</button>
                    </div>
                </div>

                {/* Day summary */}
                {hourly.length > 0 && (
                    <div className="flex gap-2 mb-3">
                        <div className="flex-1 rounded-lg bg-gray-50 ring-1 ring-gray-200 py-2 text-center">
                            <div className="text-[10px] font-bold uppercase tracking-wider text-gray-500">{tx('Latest', 'Último')}</div>
                            <div className="text-xl font-black tabular-nums" style={{ color: barColor(latest) }}>{latest.toFixed(1)}%</div>
                        </div>
                        <div className="flex-1 rounded-lg bg-gray-50 ring-1 ring-gray-200 py-2 text-center">
                            <div className="text-[10px] font-bold uppercase tracking-wider text-gray-500">{tx('Peak', 'Máximo')}</div>
                            <div className="text-xl font-black tabular-nums" style={{ color: barColor(peak) }}>{peak.toFixed(1)}%</div>
                        </div>
                        <div className="flex-1 rounded-lg bg-gray-50 ring-1 ring-gray-200 py-2 text-center">
                            <div className="text-[10px] font-bold uppercase tracking-wider text-gray-500">{tx('Hours', 'Horas')}</div>
                            <div className="text-xl font-black tabular-nums text-gray-800">{hourly.length}</div>
                        </div>
                    </div>
                )}

                {/* Body */}
                {loading ? (
                    <p className="text-xs text-gray-400 italic py-6 text-center">{tx('Loading…', 'Cargando…')}</p>
                ) : error ? (
                    <p className="text-xs text-amber-700 py-4 text-center">{tx('Couldn’t load labor history.', 'No se pudo cargar el historial.')}</p>
                ) : hourly.length === 0 ? (
                    <p className="text-xs text-gray-400 italic py-6 text-center">
                        {tx('No labor data recorded for this day.', 'Sin datos de mano de obra para este día.')}
                    </p>
                ) : (
                    <div className="space-y-1">
                        {hourly.map(h => (
                            <div key={h.hour} className="flex items-center gap-2">
                                <div className="w-14 text-[11px] font-bold text-gray-500 tabular-nums text-right">{h.label}</div>
                                <div className="flex-1 h-5 bg-gray-100 rounded overflow-hidden relative">
                                    <div className="h-full rounded transition-all"
                                        style={{ width: Math.min((h.pct / maxBar) * 100, 100) + '%', backgroundColor: barColor(h.pct) }} />
                                    {/* Target reference marker */}
                                    <div className="absolute top-0 h-5 border-r border-gray-400/60"
                                        style={{ left: Math.min((TARGET_REF / maxBar) * 100, 100) + '%' }} />
                                </div>
                                <div className="w-12 text-[11px] font-black tabular-nums text-right" style={{ color: barColor(h.pct) }}>
                                    {h.pct.toFixed(1)}%
                                </div>
                            </div>
                        ))}
                        <div className="text-[10px] text-gray-400 pt-1">
                            {tx(`Vertical line = ${TARGET_REF}% reference.`, `Línea vertical = referencia ${TARGET_REF}%.`)}
                        </div>
                    </div>
                )}
            </div>)}
        </div>
    );
}
