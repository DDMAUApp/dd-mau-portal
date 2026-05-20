// Calendar events — federal holidays, food observance days, restaurant
// industry milestones. Surface on the Schedule view so the team sees
// context ("Today is Memorial Day", "National Pho Day next Thursday")
// without having to look it up elsewhere.
//
// Andrew 2026-05-20 — "in the schedule above or below the days i dont
// see the calenders. things like hoidays, today is national wings day
// or stuff like that".
//
// Two kinds of events:
//   FIXED          — same calendar date every year. { mmdd: 'MM-DD' }
//   COMPUTED       — moveable (e.g. Thanksgiving = 4th Thursday of Nov).
//                    Resolved per-year via a function.
//
// Add events freely. Keep the list curated — the chip strip gets noisy
// past a couple events per week. Each event has:
//   en, es     — display label (kept short, 1–3 words is ideal)
//   icon       — emoji that paints next to the label
//   kind       — 'holiday' | 'food' | 'observance'
//                drives the color tone in the UI.
//
// To pull events for a date, call `getEventsForDate(dateOrIso)` — it
// returns an array (multiple events on the same day are possible, e.g.
// July 4 = Independence Day + some food day).

const FIXED_EVENTS = [
    // ── US Federal / public holidays (fixed dates) ────────────────
    { mmdd: '01-01', en: "New Year's Day", es: 'Año Nuevo', icon: '🎉', kind: 'holiday' },
    { mmdd: '02-14', en: "Valentine's Day", es: 'San Valentín', icon: '💝', kind: 'observance' },
    { mmdd: '03-17', en: "St. Patrick's Day", es: 'San Patricio', icon: '☘️', kind: 'observance' },
    { mmdd: '05-05', en: 'Cinco de Mayo', es: 'Cinco de Mayo', icon: '🇲🇽', kind: 'observance' },
    { mmdd: '06-19', en: 'Juneteenth', es: 'Juneteenth', icon: '🟥', kind: 'holiday' },
    { mmdd: '07-04', en: 'Independence Day', es: 'Día de la Independencia', icon: '🎆', kind: 'holiday' },
    { mmdd: '10-31', en: 'Halloween', es: 'Halloween', icon: '🎃', kind: 'observance' },
    { mmdd: '11-11', en: 'Veterans Day', es: 'Día de los Veteranos', icon: '🎖️', kind: 'holiday' },
    { mmdd: '12-24', en: "Christmas Eve", es: 'Nochebuena', icon: '🎄', kind: 'holiday' },
    { mmdd: '12-25', en: 'Christmas', es: 'Navidad', icon: '🎁', kind: 'holiday' },
    { mmdd: '12-31', en: "New Year's Eve", es: 'Fin de Año', icon: '🥂', kind: 'holiday' },

    // ── Food / restaurant observances ─────────────────────────────
    // Curated for a Vietnamese fast-casual. Add freely.
    { mmdd: '01-04', en: 'Natl. Spaghetti Day', es: 'Día Nac. del Espagueti', icon: '🍝', kind: 'food' },
    { mmdd: '02-09', en: 'Natl. Pizza Day', es: 'Día Nac. de la Pizza', icon: '🍕', kind: 'food' },
    { mmdd: '03-26', en: 'Natl. Spinach Day', es: 'Día Nac. de la Espinaca', icon: '🥬', kind: 'food' },
    { mmdd: '04-12', en: 'Natl. Grilled Cheese Day', es: 'Día Nac. del Sándwich', icon: '🧀', kind: 'food' },
    { mmdd: '05-05', en: 'Natl. Hoagie Day', es: 'Día Nac. del Hoagie', icon: '🥖', kind: 'food' },
    { mmdd: '06-04', en: 'Natl. Cheese Day', es: 'Día Nac. del Queso', icon: '🧀', kind: 'food' },
    { mmdd: '06-15', en: 'Natl. Bánh Mì Day', es: 'Día Nac. del Bánh Mì', icon: '🥖', kind: 'food' },
    { mmdd: '07-04', en: 'Natl. BBQ Day', es: 'Día Nac. del BBQ', icon: '🔥', kind: 'food' },
    { mmdd: '07-13', en: 'Natl. French Fry Day', es: 'Día Nac. de las Papas Fritas', icon: '🍟', kind: 'food' },
    { mmdd: '07-29', en: 'Natl. Chicken Wing Day', es: 'Día Nac. de las Alas', icon: '🍗', kind: 'food' },
    { mmdd: '08-04', en: 'Natl. Chocolate Chip Cookie Day', es: 'Día Nac. de la Galleta', icon: '🍪', kind: 'food' },
    { mmdd: '08-20', en: 'Natl. Pho Day', es: 'Día Nac. del Pho', icon: '🍜', kind: 'food' },
    { mmdd: '09-18', en: 'Natl. Cheeseburger Day', es: 'Día Nac. de la Hamburguesa', icon: '🍔', kind: 'food' },
    { mmdd: '10-04', en: 'Natl. Taco Day', es: 'Día Nac. del Taco', icon: '🌮', kind: 'food' },
    { mmdd: '10-25', en: 'Natl. Greasy Foods Day', es: 'Día Nac. de la Comida Grasosa', icon: '🍟', kind: 'food' },
    { mmdd: '11-03', en: 'Natl. Sandwich Day', es: 'Día Nac. del Sándwich', icon: '🥪', kind: 'food' },
    { mmdd: '12-22', en: 'Natl. Pho Day', es: 'Día Nac. del Pho', icon: '🍜', kind: 'food' },
];

// ── Moveable events ────────────────────────────────────────────────
// nthWeekday(year, monthIdx, weekday, n)
//   monthIdx: 0–11
//   weekday:  0=Sun..6=Sat
//   n:        1-based ordinal (1 = first, 2 = second…)
function nthWeekdayOfMonth(year, monthIdx, weekday, n) {
    const first = new Date(year, monthIdx, 1);
    const offset = (weekday - first.getDay() + 7) % 7;
    return new Date(year, monthIdx, 1 + offset + (n - 1) * 7);
}
// lastWeekdayOfMonth — used for Memorial Day (last Mon in May).
function lastWeekdayOfMonth(year, monthIdx, weekday) {
    const last = new Date(year, monthIdx + 1, 0); // last day of month
    const offset = (last.getDay() - weekday + 7) % 7;
    return new Date(year, monthIdx, last.getDate() - offset);
}

// Computed events for a given year. Memoize per-year so we don't
// recompute on every render.
const COMPUTED_CACHE = new Map();
function computedEventsForYear(year) {
    if (COMPUTED_CACHE.has(year)) return COMPUTED_CACHE.get(year);
    const events = [];
    const push = (date, ev) => events.push({
        mmdd: `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`,
        ...ev,
    });
    // MLK Day — 3rd Monday in January
    push(nthWeekdayOfMonth(year, 0, 1, 3),
        { en: 'MLK Day', es: 'Día de MLK', icon: '🕊️', kind: 'holiday' });
    // Presidents Day — 3rd Monday in February
    push(nthWeekdayOfMonth(year, 1, 1, 3),
        { en: "Presidents' Day", es: 'Día de los Presidentes', icon: '🇺🇸', kind: 'holiday' });
    // Mother's Day — 2nd Sunday in May
    push(nthWeekdayOfMonth(year, 4, 0, 2),
        { en: "Mother's Day", es: 'Día de la Madre', icon: '💐', kind: 'observance' });
    // Memorial Day — last Monday in May
    push(lastWeekdayOfMonth(year, 4, 1),
        { en: 'Memorial Day', es: 'Día de los Caídos', icon: '🇺🇸', kind: 'holiday' });
    // Father's Day — 3rd Sunday in June
    push(nthWeekdayOfMonth(year, 5, 0, 3),
        { en: "Father's Day", es: 'Día del Padre', icon: '🎩', kind: 'observance' });
    // Labor Day — 1st Monday in September
    push(nthWeekdayOfMonth(year, 8, 1, 1),
        { en: 'Labor Day', es: 'Día del Trabajo', icon: '🛠', kind: 'holiday' });
    // Columbus / Indigenous Peoples Day — 2nd Monday in October
    push(nthWeekdayOfMonth(year, 9, 1, 2),
        { en: 'Columbus Day', es: 'Día de Colón', icon: '🌎', kind: 'observance' });
    // Thanksgiving — 4th Thursday in November
    push(nthWeekdayOfMonth(year, 10, 4, 4),
        { en: 'Thanksgiving', es: 'Día de Gracias', icon: '🦃', kind: 'holiday' });
    COMPUTED_CACHE.set(year, events);
    return events;
}

// Build a lookup keyed by 'YYYY-MM-DD' so the consumer can do a single
// Map.get(dateStr). Cached per-year.
const PER_YEAR_INDEX = new Map();
function buildIndexForYear(year) {
    if (PER_YEAR_INDEX.has(year)) return PER_YEAR_INDEX.get(year);
    const idx = new Map();
    const add = (mmdd, ev) => {
        const key = `${year}-${mmdd}`;
        const list = idx.get(key) || [];
        list.push(ev);
        idx.set(key, list);
    };
    for (const ev of FIXED_EVENTS) add(ev.mmdd, ev);
    for (const ev of computedEventsForYear(year)) add(ev.mmdd, ev);
    PER_YEAR_INDEX.set(year, idx);
    return idx;
}

// Get all events for a specific date.
// Accepts a Date OR a 'YYYY-MM-DD' string.
export function getEventsForDate(dateOrIso) {
    let d, key;
    if (dateOrIso instanceof Date) {
        d = dateOrIso;
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const da = String(d.getDate()).padStart(2, '0');
        key = `${y}-${m}-${da}`;
    } else if (typeof dateOrIso === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateOrIso)) {
        key = dateOrIso;
        const [y] = dateOrIso.split('-').map(Number);
        d = new Date(y, 0, 1); // year only is what we need
    } else {
        return [];
    }
    const idx = buildIndexForYear(d.getFullYear());
    return idx.get(key) || [];
}

// Tone tokens for the UI — kept here so callers don't reinvent.
export const EVENT_KIND_TONES = {
    holiday:    { bg: 'bg-amber-50',   border: 'border-amber-200', text: 'text-amber-800' },
    food:       { bg: 'bg-rose-50',    border: 'border-rose-200',  text: 'text-rose-800' },
    observance: { bg: 'bg-indigo-50',  border: 'border-indigo-200', text: 'text-indigo-800' },
};
