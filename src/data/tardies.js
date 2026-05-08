// DD Mau Tardiness Tracker — rolling 60-day progressive discipline.
//
// Industry-standard fast-casual escalation: each tardy in the rolling
// window pushes the staff member up a tier. Once a tardy is older than
// the window, it stops counting toward the tier (but stays in the
// historical record for audit).
//
// Excused tardies (sick with note, doctor's appointment, family
// emergency with management blessing) DO NOT count toward the tier.
// They're still recorded so the pattern is visible but get a 🛡 tag.

export const ROLLING_WINDOW_DAYS = 60;

// Progressive-discipline tiers. Returned by tierFor(count).
// Color tokens follow the same vocabulary as the rest of the app.
export const TARDY_TIERS = [
    { id: "clear",   min: 0, max: 0,        labelEn: "Clear",                   labelEs: "Sin Faltas",            emoji: "✅", color: "bg-green-100 text-green-800 border-green-300",   short: "0" },
    { id: "verbal",  min: 1, max: 1,        labelEn: "Verbal Warning",          labelEs: "Aviso Verbal",          emoji: "📝", color: "bg-yellow-100 text-yellow-800 border-yellow-300", short: "1" },
    { id: "written", min: 2, max: 2,        labelEn: "Written Warning",         labelEs: "Aviso Escrito",         emoji: "✍️", color: "bg-orange-100 text-orange-800 border-orange-300", short: "2" },
    { id: "final",   min: 3, max: 3,        labelEn: "Final Warning",           labelEs: "Aviso Final",           emoji: "🚨", color: "bg-red-100 text-red-800 border-red-300",         short: "3" },
    { id: "term",    min: 4, max: Infinity, labelEn: "Termination Conversation", labelEs: "Conversación de Despido", emoji: "🛑", color: "bg-red-700 text-white border-red-900",            short: "4+" },
];

export function tierFor(count) {
    return TARDY_TIERS.find(t => count >= t.min && count <= t.max) || TARDY_TIERS[0];
}

// Standard reason picker — keeps reporting clean. "Other" allows free
// text via the reasonText field. Sick/family-emergency get a hint that
// they MAY warrant an excused tag from the manager.
export const TARDY_REASONS = [
    { id: "overslept",  emoji: "😴", labelEn: "Overslept",                labelEs: "Se quedó dormido" },
    { id: "transit",    emoji: "🚗", labelEn: "Traffic / transport",      labelEs: "Tráfico / transporte" },
    { id: "sick",       emoji: "🤒", labelEn: "Sick",                     labelEs: "Enfermo",                excusable: true },
    { id: "family",     emoji: "🏠", labelEn: "Family emergency",         labelEs: "Emergencia familiar",    excusable: true },
    { id: "appointment",emoji: "📅", labelEn: "Doctor / appointment",     labelEs: "Doctor / cita",          excusable: true },
    { id: "no_call",    emoji: "📞", labelEn: "No call / no show late",   labelEs: "Sin aviso" },
    { id: "other",      emoji: "❓", labelEn: "Other (note)",             labelEs: "Otro (nota)" },
];
export const TARDY_REASON_BY_ID = Object.fromEntries(TARDY_REASONS.map(r => [r.id, r]));

// "Minutes late" preset chips so managers can tap instead of type. The
// last value forces manual entry.
export const TARDY_MINUTES_PRESETS = [5, 10, 15, 30, 45, 60];

// Date helper anchored to the business time zone. Aliased to local helpers
// already in use (Operations.jsx has the same pattern). Defined here so the
// tardies component doesn't need to import from Operations.
const BUSINESS_TZ = "America/Chicago";
const _dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: BUSINESS_TZ, year: "numeric", month: "2-digit", day: "2-digit" });
export const getBusinessDateKey = (d = new Date()) => _dayFmt.format(d);

// Subtract N days from a YYYY-MM-DD string and return a new YYYY-MM-DD.
// Anchored at noon UTC so DST transitions don't drift the day.
export function subtractDays(dateKey, n) {
    const [y, m, d] = dateKey.split("-").map(Number);
    const t = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
    t.setUTCDate(t.getUTCDate() - n);
    const yy = t.getUTCFullYear();
    const mm = String(t.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(t.getUTCDate()).padStart(2, "0");
    return `${yy}-${mm}-${dd}`;
}

export function addDaysKey(dateKey, n) { return subtractDays(dateKey, -n); }

// Filter all tardies down to those that count toward the rolling tier
// for `staffName`. Excused entries do NOT count. Returns the array sorted
// most-recent first.
export function countingTardies(allTardies, staffName) {
    if (!Array.isArray(allTardies)) return [];
    const today = getBusinessDateKey();
    const cutoff = subtractDays(today, ROLLING_WINDOW_DAYS - 1); // inclusive of 60 calendar days
    return allTardies
        .filter(t => t.staffName === staffName)
        .filter(t => !t.excused)
        .filter(t => t.date >= cutoff && t.date <= today)
        .sort((a, b) => b.date.localeCompare(a.date));
}

// Date the OLDEST counted tardy will fall off the window. Useful for the
// "next clears on YYYY-MM-DD" hint shown to staff.
export function nextFalloffDate(countingList) {
    if (!Array.isArray(countingList) || countingList.length === 0) return null;
    const oldest = countingList[countingList.length - 1];
    if (!oldest?.date) return null;
    return addDaysKey(oldest.date, ROLLING_WINDOW_DAYS);
}
