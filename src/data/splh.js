// SPLH (Sales Per Labor Hour) — shared math + constants used by both
// LaborDashboard (historical view) and Schedule (forecasting/advisor view).
//
// SPLH = $ sales produced per labor hour scheduled. Higher = more efficient.
// Industry rule of thumb for fast-casual: ~$80–$150 SPLH is a healthy band;
// below $80 usually means over-staffed, above $150 often means under-staffed
// (lines back up, guests walk). DD Mau's actual numbers will tune over time.

export const DAYPARTS = [
    { id: 'lunch',  enLabel: 'Lunch',  esLabel: 'Almuerzo', startHr: 11, endHr: 14 },
    { id: 'slow',   enLabel: 'Slow',   esLabel: 'Lento',    startHr: 14, endHr: 16 },
    { id: 'dinner', enLabel: 'Dinner', esLabel: 'Cena',     startHr: 16, endHr: 20 },
    { id: 'late',   enLabel: 'Late',   esLabel: 'Tarde',    startHr: 20, endHr: 23 },
];

export const DOW_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const DOW_ES = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

// Tonal thresholds for SPLH cells. Tunable as DD Mau accumulates data.
export const SPLH_GOOD = 120;   // ≥ this is healthy productivity
export const SPLH_SOFT = 80;    // [SOFT, GOOD) is amber, < SOFT is red

export function dowFromKey(dateKey) {
    if (!dateKey) return null;
    const [y, m, d] = String(dateKey).split('-').map(Number);
    if (!y || !m || !d) return null;
    return new Date(y, m - 1, d).getDay();
}

// Accept "HH:MM", "H:MM", "H:MM AM/PM" → 0..23 hour.
export function hrFromTime(timeStr) {
    if (!timeStr) return null;
    const m = String(timeStr).match(/(\d{1,2}):(\d{2})(?:\s*(AM|PM))?/i);
    if (!m) return null;
    let h = parseInt(m[1], 10);
    const ampm = m[3]?.toUpperCase();
    if (ampm === 'PM' && h < 12) h += 12;
    if (ampm === 'AM' && h === 12) h = 0;
    return h;
}

export function fmtUSD(n) {
    if (!Number.isFinite(n)) return '—';
    return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

export function dayPartFor(hr) {
    if (hr == null) return null;
    return DAYPARTS.find(p => hr >= p.startHr && hr < p.endHr) || null;
}

// Roll an array of hourly laborHistory entries into a [dow][partId] grid:
//   { 5: { lunch: { sales, hours, splh, n }, dinner: {...} }, ... }
// where n = number of distinct days contributing (sample size).
// Tolerates missing/malformed entries — silently skips anything without
// numeric netSales + positive totalHours.
export function aggregateSplh(history) {
    const acc = {}; // acc[dow][partId] = { sales, hours, days: Set<dateKey> }
    for (const e of (history || [])) {
        const sales = Number(e.netSales);
        const hours = Number(e.totalHours);
        if (!Number.isFinite(sales) || !Number.isFinite(hours) || hours <= 0) continue;
        const dow = dowFromKey(e.date);
        const hr = hrFromTime(e.time);
        const part = dayPartFor(hr);
        if (dow == null || !part) continue;
        if (!acc[dow]) acc[dow] = {};
        if (!acc[dow][part.id]) acc[dow][part.id] = { sales: 0, hours: 0, days: new Set() };
        acc[dow][part.id].sales += sales;
        acc[dow][part.id].hours += hours;
        acc[dow][part.id].days.add(e.date);
    }
    const out = {};
    for (const dow of Object.keys(acc)) {
        out[dow] = {};
        for (const partId of Object.keys(acc[dow])) {
            const c = acc[dow][partId];
            const n = c.days.size || 0;
            out[dow][partId] = {
                sales: c.sales,
                hours: c.hours,
                splh: c.hours > 0 ? c.sales / c.hours : null,
                avgSales: n > 0 ? c.sales / n : 0,    // typical sales for this slot
                avgHours: n > 0 ? c.hours / n : 0,    // typical scheduled hours
                n,
            };
        }
    }
    return out;
}

// Given an array of currently-scheduled shifts ({date, startTime, endTime}),
// compute total hours per [dow][partId]. Used by the Schedule advisor to
// compare plan vs typical.
export function scheduledHoursByDayPart(shifts, weekStart) {
    const out = {}; // out[dow][partId] = hours
    for (const sh of (shifts || [])) {
        if (!sh.date || !sh.startTime || !sh.endTime) continue;
        // Skip drafts? No — show TOTAL planned. Manager sees the picture
        // they're building before publish.
        const dow = dowFromKey(sh.date);
        const sh0 = hrFromTime(sh.startTime);
        const sh1 = hrFromTime(sh.endTime);
        if (dow == null || sh0 == null || sh1 == null) continue;
        // Allocate the shift's hours into each daypart bucket it overlaps.
        for (const part of DAYPARTS) {
            const overlap = Math.max(0, Math.min(sh1, part.endHr) - Math.max(sh0, part.startHr));
            if (overlap > 0) {
                if (!out[dow]) out[dow] = {};
                out[dow][part.id] = (out[dow][part.id] || 0) + overlap;
            }
        }
    }
    return out;
}

export function splhTone(splh) {
    if (splh == null) return 'bg-gray-50 text-gray-400 border-gray-200';
    if (splh >= SPLH_GOOD) return 'bg-emerald-100 text-emerald-800 border-emerald-300';
    if (splh >= SPLH_SOFT) return 'bg-amber-50 text-amber-800 border-amber-200';
    return 'bg-red-50 text-red-700 border-red-200';
}

// "Variance" between scheduled hours and typical hours for a slot.
// Returns {pct, status, recommendedDelta}:
//   pct: signed percent difference (+ = over-staffed, - = under)
//   status: 'over'|'under'|'on'|'unknown'
//   recommendedDelta: rough hours-to-add (negative = trim) suggestion
export function variance(scheduledHrs, typicalHrs) {
    if (!Number.isFinite(typicalHrs) || typicalHrs <= 0) return { pct: null, status: 'unknown', recommendedDelta: 0 };
    const pct = ((scheduledHrs || 0) - typicalHrs) / typicalHrs;
    let status = 'on';
    if (pct > 0.15) status = 'over';
    else if (pct < -0.15) status = 'under';
    return { pct, status, recommendedDelta: typicalHrs - (scheduledHrs || 0) };
}
