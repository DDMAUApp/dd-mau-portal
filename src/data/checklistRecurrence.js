// Daily Ops checklist recurrence — ONE matcher shared by the Tasks page
// (Operations.jsx) and the Task Planner (taskPlan.js / TaskPlanner.jsx).
//
// A checklist task carries `recurrence` (string id). Before 2026-08-19 the
// ids were fixed presets (daily / weekday / weekend / monday…sunday).
// Andrew: "select the tasks to be everyday, certain day of the week, or a
// certain calendar day where I can choose multiple days" → two new ids:
//   • 'days'  + recurDays:  [0..6]            several weekdays (0 = Sun)
//   • 'dates' + recurDates: ['YYYY-MM-DD', …] specific calendar days
// Unknown / missing recurrence = daily (same fallback as before).

export const PRESET_RECURRENCE = [
    { id: 'daily',     labelEn: 'Every day',  labelEs: 'Cada día' },
    { id: 'weekday',   labelEn: 'Weekdays',   labelEs: 'Lunes-Viernes' },
    { id: 'weekend',   labelEn: 'Weekends',   labelEs: 'Fines de semana' },
    { id: 'monday',    labelEn: 'Mondays',    labelEs: 'Lunes' },
    { id: 'tuesday',   labelEn: 'Tuesdays',   labelEs: 'Martes' },
    { id: 'wednesday', labelEn: 'Wednesdays', labelEs: 'Miércoles' },
    { id: 'thursday',  labelEn: 'Thursdays',  labelEs: 'Jueves' },
    { id: 'friday',    labelEn: 'Fridays',    labelEs: 'Viernes' },
    { id: 'saturday',  labelEn: 'Saturdays',  labelEs: 'Sábados' },
    { id: 'sunday',    labelEn: 'Sundays',    labelEs: 'Domingos' },
];
export const PRESET_BY_ID = Object.fromEntries(PRESET_RECURRENCE.map(r => [r.id, r]));

const PRESET_MATCH = {
    daily:     () => true,
    weekday:   w => w >= 1 && w <= 5,
    weekend:   w => w === 0 || w === 6,
    monday:    w => w === 1,
    tuesday:   w => w === 2,
    wednesday: w => w === 3,
    thursday:  w => w === 4,
    friday:    w => w === 5,
    saturday:  w => w === 6,
    sunday:    w => w === 0,
};

const WD_SHORT_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WD_SHORT_ES = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

export function normalizeRecurDays(v) {
    if (!Array.isArray(v)) return [];
    return [...new Set(v.map(n => Number(n)).filter(n => Number.isInteger(n) && n >= 0 && n <= 6))].sort((a, b) => a - b);
}
export function normalizeRecurDates(v) {
    if (!Array.isArray(v)) return [];
    return [...new Set(v.map(s => String(s || '').trim()).filter(s => /^\d{4}-\d{2}-\d{2}$/.test(s)))].sort();
}

// Does this task show on the given business day?
//   weekday: 0..6 (Chicago day-of-week of that day)
//   dateStr: 'YYYY-MM-DD' (Chicago) — needed for 'dates'
export function taskDueOnDay(task, weekday, dateStr) {
    const r = task?.recurrence || 'daily';
    if (r === 'days') return normalizeRecurDays(task?.recurDays).includes(weekday);
    if (r === 'dates') return !!dateStr && normalizeRecurDates(task?.recurDates).includes(dateStr);
    return (PRESET_MATCH[r] || PRESET_MATCH.daily)(weekday);
}

// Human label for chips/badges.
export function recurrenceLabelFor(task, language = 'en') {
    const es = language === 'es';
    const r = task?.recurrence || 'daily';
    if (r === 'days') {
        const days = normalizeRecurDays(task?.recurDays);
        if (days.length === 0) return es ? 'Ningún día' : 'No days';
        if (days.length === 7) return es ? 'Cada día' : 'Every day';
        if (days.join(',') === '1,2,3,4,5') return es ? 'Lunes-Viernes' : 'Weekdays';
        if (days.join(',') === '0,6') return es ? 'Fines de semana' : 'Weekends';
        return days.map(d => (es ? WD_SHORT_ES : WD_SHORT_EN)[d]).join(' · ');
    }
    if (r === 'dates') {
        const dates = normalizeRecurDates(task?.recurDates);
        if (dates.length === 0) return es ? 'Sin fechas' : 'No dates';
        const fmt = (s) => `${Number(s.slice(5, 7))}/${Number(s.slice(8))}`;
        return dates.length <= 3 ? dates.map(fmt).join(', ') : `${dates.slice(0, 2).map(fmt).join(', ')} +${dates.length - 2}`;
    }
    const p = PRESET_BY_ID[r];
    return p ? (es ? p.labelEs : p.labelEn) : r;
}

// Strip recurrence companions that don't belong to the chosen id — keeps
// stale recurDays/recurDates from lingering on a task switched back to a
// preset.
export function cleanRecurrenceFields(task) {
    const next = { ...task };
    if (next.recurrence !== 'days') delete next.recurDays;
    if (next.recurrence !== 'dates') delete next.recurDates;
    if (!next.recurrence || next.recurrence === 'daily') delete next.recurrence;
    return next;
}

// ── Per-assignee day schedules (2026-08-19) ─────────────────────────────
// Andrew: "for one item on the task list, if I add more than one person,
// give me the option to change what day that person has that task —
// without changing the whole task." Optional map on the task:
//   assignDays: { [name]: { recurrence: 'days'|'dates', recurDays?, recurDates? } }
// No entry (or recurrence 'daily') = that person has it every day the task
// shows. The task's own recurrence still decides when the task appears at
// all; assignDays only decides WHO carries it that day.

export function personDueOnDay(sched, weekday, dateStr) {
    if (!sched || !sched.recurrence || sched.recurrence === 'daily') return true;
    if (sched.recurrence === 'days') return normalizeRecurDays(sched.recurDays).includes(weekday);
    if (sched.recurrence === 'dates') return !!dateStr && normalizeRecurDates(sched.recurDates).includes(dateStr);
    return true;
}

// The assignees who actually carry the task on a given day.
export function assigneesOnDay(task, weekday, dateStr) {
    const all = Array.isArray(task?.assignTo) ? task.assignTo : (task?.assignTo ? [task.assignTo] : []);
    const ad = (task && typeof task.assignDays === 'object' && task.assignDays) || {};
    return all.filter(n => personDueOnDay(ad[n], weekday, dateStr));
}

// Sanitize an assignDays map: only names in assignTo, only valid schedules;
// 'daily'/empty entries are dropped (absence already means "every day").
export function normalizeAssignDays(v, assignTo) {
    const names = new Set(Array.isArray(assignTo) ? assignTo : []);
    const out = {};
    if (v && typeof v === 'object') {
        for (const [name, sched] of Object.entries(v)) {
            if (!names.has(name) || !sched || typeof sched !== 'object') continue;
            if (sched.recurrence === 'days') {
                const days = normalizeRecurDays(sched.recurDays);
                if (days.length) out[name] = { recurrence: 'days', recurDays: days };
            } else if (sched.recurrence === 'dates') {
                const dates = normalizeRecurDates(sched.recurDates).slice(0, 120);
                if (dates.length) out[name] = { recurrence: 'dates', recurDates: dates };
            }
        }
    }
    return out;
}
