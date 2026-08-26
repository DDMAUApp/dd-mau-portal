// TaskPlanner — admin calendar for planning recurring manager tasks
// (Andrew 2026-07-27: "a task tab in the admin page where i can plan the
// tasks for the month or week … some repeat everyday and some every other
// day … pull up a calendar and add or move tasks around … managers still
// check off the tasks everyday like they do now").
//
// Rules live in /task_plan (src/data/taskPlan.js). Each day the plan
// materializes into REAL /assigned_tasks docs (see ensureMaterializedFor
// Today), so the existing kanban / My Tasks pages are untouched, and an
// unchecked non-daily task simply stays open on the board (carry-over).
//
// Interactions:
//   • ‹ month › nav; tap a DAY → day sheet (tasks due + add form)
//   • Daily Ops rows edit INLINE (Andrew 2026-07-29): drag ≡ to reorder,
//     type the text right there, pick assignee + complete-by time; ✏️
//     opens a tiny which-days popover; 🗑 deletes
//   • tap a planned chip → edit series, skip this day, move this
//     occurrence (arms move mode → tap the target day), end or delete
//   • ⚡ Generate today now — runs the materializer immediately
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
    subscribeTaskPlan, createTaskPlanRule, updateTaskPlanRule,
    archiveTaskPlanRule, deleteTaskPlanRule, skipOccurrence, moveOccurrence,
    rulesDueOn, ensureMaterializedForToday, toDateStr, addDaysStr, weekdayOf,
    fetchOpsChecklistDay, checklistTasksForDay,
    updateOpsChecklistTask, deleteOpsChecklistTask, moveOpsChecklistTask,
} from '../data/taskPlan';
import { inferStaffSide } from '../data/assignedTasks';
import { db } from '../firebase';
import { doc, onSnapshot } from 'firebase/firestore';
import { taskDueOnDay, recurrenceLabelFor, normalizeRecurDays, normalizeRecurDates, assigneesOnDay } from '../data/checklistRecurrence';
import { toast } from '../toast';
import ModalPortal from './ModalPortal';

// Auto-growing single-field text box (Andrew 2026-08-19: "when I click a
// task to edit make the input expand to the size of the text … so I can
// read the whole text"). A <textarea> that sizes itself to its content —
// long task text wraps instead of scrolling off the right edge. Enter
// still commits (tasks are one-liners); Shift+Enter is swallowed too so
// no newlines sneak into task strings.
function GrowingText({ value, onChange, className = '', minRows = 1, onEnter, ...rest }) {
    const ref = useRef(null);
    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        el.style.height = 'auto';
        el.style.height = `${el.scrollHeight}px`;
    }, [value]);
    return (
        <textarea
            ref={ref}
            rows={minRows}
            value={value}
            onChange={onChange}
            onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); if (onEnter) onEnter(e); else e.currentTarget.blur(); }
            }}
            className={`resize-none overflow-hidden leading-snug ${className}`}
            {...rest}
        />
    );
}

const WD_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WD_ES = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
const MONTHS_EN = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const MONTHS_ES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];

function recurrenceLabel(rule, isEs) {
    const r = rule.recurrence || {};
    switch (r.type) {
        case 'daily': return isEs ? 'Diario' : 'Every day';
        case 'everyN': return (Number(r.n) === 2)
            ? (isEs ? 'Cada 2 días' : 'Every other day')
            : (isEs ? `Cada ${r.n} días` : `Every ${r.n} days`);
        case 'weekly': {
            const wd = isEs ? WD_ES : WD_EN;
            return (r.weekdays || []).map(i => wd[i]).join(', ');
        }
        default: return isEs ? 'Un día' : 'One day';
    }
}

export default function TaskPlanner({ language = 'en', staffName, staffList = [], storeLocation, startExpanded = false }) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);

    // 2026-07-29 — admin hub reorg: AdminPanel now opens each tool full-screen
    // from a tile grid; startExpanded lets the tool view mount pre-expanded
    // (default false keeps the old collapsed-header behavior everywhere else).
    const [expanded, setExpanded] = useState(startExpanded);
    const [rules, setRules] = useState([]);
    // First day of the displayed month, as a date string.
    const [monthAnchor, setMonthAnchor] = useState(() => toDateStr().slice(0, 8) + '01');
    const [daySheet, setDaySheet] = useState(null);      // 'YYYY-MM-DD' | null
    const [editRule, setEditRule] = useState(null);      // { rule, date } | null
    const [moveArm, setMoveArm] = useState(null);        // { rule, fromDate } | null
    const [generating, setGenerating] = useState(false);

    useEffect(() => {
        if (!expanded) return;
        return subscribeTaskPlan(setRules);
    }, [expanded]);

    // 2026-08-19 (Andrew): "each calendar day shows names with the number of
    // tasks per day — chris6 and dan5". Live Daily Ops list for the chosen
    // store; each cell tallies that day's due tasks per assignee (FOH + BOH)
    // plus any planned rules. 📥 = unassigned.
    const [calLoc, setCalLoc] = useState(storeLocation === 'maryland' ? 'maryland' : 'webster');
    const [calTasks, setCalTasks] = useState(null); // customTasks of the live checklist doc
    useEffect(() => {
        if (!expanded) return undefined;
        const unsub = onSnapshot(doc(db, 'ops', 'checklists2_' + calLoc),
            (snap) => setCalTasks(snap.exists() ? (snap.data()?.customTasks || {}) : {}),
            (e) => { console.warn('planner checklist snapshot error:', e); setCalTasks({}); });
        return () => unsub();
    }, [expanded, calLoc]);
    const calAllTasks = useMemo(() => {
        const out = [];
        for (const side of ['FOH', 'BOH']) {
            const sd = calTasks?.[side] || {};
            const arr = Array.isArray(sd.all) ? sd.all : [...(sd.morning || []), ...(sd.afternoon || [])];
            for (const t of arr) if (t && t.id) out.push({ ...t, side });
        }
        return out;
    }, [calTasks]);
    // → [{ name, count }] sorted desc; name '📥' = unassigned
    const countsForDay = (dateStr, dueRules) => {
        const w = weekdayOf(dateStr);
        const tally = new Map();
        const bump = (n) => tally.set(n, (tally.get(n) || 0) + 1);
        for (const t of calAllTasks) {
            if (!taskDueOnDay(t, w, dateStr)) continue;
            // Day-aware: with per-person schedules (assignDays) only the
            // people on duty that day are counted; a task whose assignees
            // are ALL off that day counts as unassigned for the day.
            const who = assigneesOnDay(t, w, dateStr);
            if (who.length === 0) bump('📥'); else who.forEach(n => bump(String(n)));
        }
        for (const r of dueRules) bump(r.assignTo?.staffName || '📥');
        return [...tally.entries()].map(([name, count]) => ({ name, count }))
            .sort((a, b) => (a.name === '📥') - (b.name === '📥') || b.count - a.count || a.name.localeCompare(b.name));
    };

    const today = toDateStr();
    const activeRules = useMemo(() => rules.filter(r => r.active !== false), [rules]);

    // Calendar cells: leading blanks + every day of the month.
    const cells = useMemo(() => {
        const [y, m] = monthAnchor.split('-').map(Number);
        const daysInMonth = new Date(y, m, 0).getDate();
        const lead = weekdayOf(monthAnchor);
        const out = [];
        for (let i = 0; i < lead; i++) out.push(null);
        for (let d = 1; d <= daysInMonth; d++) {
            out.push(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
        }
        return out;
    }, [monthAnchor]);

    // Map(dateStr → [{name, count}]) for the visible month, computed ONCE
    // per data change (2026-08-25 audit): countsForDay used to run inside
    // the cells map — ~31 cells × every render (each state flip: move-arm,
    // day-sheet open, month nav press-state…). Deps are the actual inputs:
    // the checklist tasks (calTasks/calAllTasks), the active rules, and the
    // month's cells. Empty map while calTasks === null preserves the old
    // "render nothing until the checklist doc lands" behavior.
    const countsByDay = useMemo(() => {
        const map = new Map();
        if (calTasks === null) return map;
        for (const dateStr of cells) {
            if (!dateStr) continue;
            map.set(dateStr, countsForDay(dateStr, rulesDueOn(activeRules, dateStr)));
        }
        return map;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [cells, activeRules, calAllTasks, calTasks]);

    const monthTitle = useMemo(() => {
        const [y, m] = monthAnchor.split('-').map(Number);
        return `${(isEs ? MONTHS_ES : MONTHS_EN)[m - 1]} ${y}`;
    }, [monthAnchor, isEs]);

    const shiftMonth = (delta) => {
        // 2026-07-27 audit R3: new Date(y, m-1+delta, 1) is DEVICE-local but
        // toDateStr re-formats in America/Chicago — on a device ahead of
        // Chicago (Andrew's phone in HKT) local "Aug 1 00:00" is still Jul 31
        // in Chicago, so › re-derived the SAME month and ‹ skipped one.
        // Pure UTC math (noon-anchored) never crosses a timezone.
        const [y, m] = monthAnchor.split('-').map(Number);
        const d = new Date(Date.UTC(y, m - 1 + delta, 1, 12));
        setMonthAnchor(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`);
    };

    const onDayTap = async (dateStr) => {
        if (moveArm) {
            // Move mode: this tap is the TARGET day.
            try {
                await moveOccurrence(moveArm.rule, moveArm.fromDate, dateStr);
                toast(tx(`Moved to ${dateStr}`, `Movido a ${dateStr}`), { kind: 'success' });
            } catch (e) {
                toast(tx('Move failed: ', 'Error al mover: ') + (e?.message || ''), { kind: 'error' });
            }
            setMoveArm(null);
            return;
        }
        setDaySheet(dateStr);
    };

    const generateNow = async () => {
        if (generating) return;
        setGenerating(true);
        try {
            // force:true — this button is an explicit "run it NOW", and the
            // Tasks page's mount call has usually already burned today's
            // throttle key (2026-07-30: without force both calls returned
            // { skipped:true } and the toast lied "already up to date").
            const [a, b] = await Promise.all([
                ensureMaterializedForToday('FOH', staffName, { force: true }),
                ensureMaterializedForToday('BOH', staffName, { force: true }),
            ]);
            // 2026-07-27 audit R9: ensureMaterializedForToday swallows its own
            // failures into { created: 0, error } — this toast claimed success
            // even when nothing materialized (offline, rules blocked, …).
            const err = a?.error || b?.error;
            if (err) {
                toast(tx('Generate failed: ', 'Error al generar: ') + err, { kind: 'error' });
                return;
            }
            // Defensive: a throttled (skipped) run proves nothing about
            // today's state, so it must never be reported as "up to date".
            if (a?.skipped || b?.skipped) {
                toast(tx('Nothing ran — try again in a moment', 'No se ejecutó — intenta de nuevo'), { kind: 'error' });
                return;
            }
            const n = (a.created || 0) + (b.created || 0);
            toast(n > 0
                ? tx(`✓ Created ${n} task(s) for today`, `✓ ${n} tarea(s) creadas para hoy`)
                : tx('Today is already up to date', 'Hoy ya está al día'),
                { kind: 'success' });
        } finally { setGenerating(false); }
    };

    return (
        <div className="mb-3">
            <button onClick={() => setExpanded(v => !v)} aria-expanded={expanded}
                className="glass-section-head tint-green">
                <div className="flex items-center gap-3 min-w-0">
                    <span className="glass-icon-tile" aria-hidden="true">🗓</span>
                    <div className="text-left min-w-0">
                        <h3 className="font-bold text-[15px] text-dd-text">{tx('Task planner', 'Planificador de tareas')}</h3>
                        <p className="text-[11px] text-dd-text-2 truncate">
                            {tx('Plan repeating manager tasks on a calendar — they appear on the Tasks page automatically each day.',
                                'Planifica tareas repetitivas en un calendario — aparecen solas cada día en Tareas.')}
                        </p>
                    </div>
                </div>
                <span className="text-dd-text-2 text-sm font-bold">{expanded ? '▼' : '▶'}</span>
            </button>

            {expanded && (
                <div className="mt-2 bg-white border-2 border-dd-line rounded-xl p-3">
                    {moveArm && (
                        <div className="mb-2 px-3 py-2 rounded-lg bg-amber-100 border border-amber-300 text-amber-900 text-xs font-bold flex items-center justify-between">
                            <span>➡️ {tx(`Tap the day to move "${moveArm.rule.task}" to`, `Toca el día al que mover "${moveArm.rule.task}"`)}</span>
                            <button onClick={() => setMoveArm(null)} className="underline">{tx('Cancel', 'Cancelar')}</button>
                        </div>
                    )}
                    <div className="flex items-center justify-between mb-2">
                        <button onClick={() => shiftMonth(-1)} className="px-3 py-1.5 rounded-lg bg-dd-bg font-bold">‹</button>
                        <div className="font-black text-dd-text">{monthTitle}</div>
                        <button onClick={() => shiftMonth(1)} className="px-3 py-1.5 rounded-lg bg-dd-bg font-bold">›</button>
                    </div>
                    <div className="flex items-center justify-between mb-2 text-[11px]">
                        <span className="text-dd-text-2">{tx('Each day: who has how many tasks (Daily Ops list + planned tasks)', 'Cada día: quién tiene cuántas tareas (lista de Ops + planificadas)')}</span>
                        <button onClick={() => setCalLoc(l => l === 'webster' ? 'maryland' : 'webster')}
                            className="px-2 py-1 rounded-md font-bold border bg-white text-dd-text-2 border-dd-line"
                            title={tx('Switch store', 'Cambiar tienda')}>
                            {calLoc === 'webster' ? '📍 Webster' : '📍 Maryland'}
                        </button>
                    </div>
                    <div className="grid grid-cols-7 gap-1 text-center text-[10px] font-bold uppercase text-dd-text-2 mb-1">
                        {(isEs ? WD_ES : WD_EN).map(d => <div key={d}>{d}</div>)}
                    </div>
                    <div className="grid grid-cols-7 gap-1">
                        {cells.map((dateStr, i) => {
                            if (!dateStr) return <div key={`b${i}`} />;
                            const isToday = dateStr === today;
                            const isPast = dateStr < today;
                            return (
                                <button key={dateStr} onClick={() => onDayTap(dateStr)}
                                    className={`min-h-[64px] rounded-lg border p-1 text-left align-top transition active:scale-95 ${
                                        isToday ? 'border-dd-green ring-2 ring-dd-green/30 bg-dd-sage-50/60'
                                        : moveArm ? 'border-amber-300 bg-amber-50/40'
                                        : 'border-dd-line bg-white hover:bg-dd-bg'} ${isPast ? 'opacity-60' : ''}`}>
                                    <div className={`text-[11px] font-bold ${isToday ? 'text-dd-green-700' : 'text-dd-text'}`}>
                                        {Number(dateStr.slice(8))}
                                    </div>
                                    <div className="space-y-0.5 mt-0.5">
                                        {(() => {
                                            const counts = countsByDay.get(dateStr) || [];
                                            const named = counts.filter(c => c.name !== '📥');
                                            const unassigned = counts.find(c => c.name === '📥');
                                            const shown = named.slice(0, 3);
                                            const more = named.length - shown.length;
                                            return (
                                                <>
                                                    {shown.map(c => (
                                                        <div key={c.name}
                                                            className="text-[9px] leading-tight truncate rounded px-1 py-0.5 font-bold bg-emerald-100 text-emerald-900"
                                                            title={`${c.name}: ${c.count}`}>
                                                            {c.name.split(' ')[0]}<span className="opacity-70"> {c.count}</span>
                                                        </div>
                                                    ))}
                                                    {more > 0 && (
                                                        <div className="text-[9px] text-dd-text-2 font-bold" title={named.slice(3).map(c => `${c.name}: ${c.count}`).join(', ')}>+{more} {tx('more', 'más')}</div>
                                                    )}
                                                    {unassigned && (
                                                        <div className="text-[9px] leading-tight truncate rounded px-1 py-0.5 font-bold bg-dd-bg text-dd-text-2" title={tx('Unassigned tasks', 'Tareas sin asignar')}>
                                                            📥 {unassigned.count}
                                                        </div>
                                                    )}
                                                </>
                                            );
                                        })()}
                                    </div>
                                </button>
                            );
                        })}
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-2 text-[10px] text-dd-text-2">
                        <span className="px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-900 font-bold">{tx('name · tasks', 'nombre · tareas')}</span>
                        <span className="px-1.5 py-0.5 rounded bg-dd-bg text-dd-text-2 font-bold">📥 {tx('unassigned', 'sin asignar')}</span>
                        <span>{tx('Tap a day to open its list and edit who / which days. Unchecked non-daily planned tasks carry over automatically.',
                            'Toca un día para abrir su lista y editar quién / qué días. Las tareas planificadas no diarias sin marcar pasan al día siguiente solas.')}</span>
                        <button onClick={generateNow} disabled={generating}
                            className="ml-auto px-3 py-1.5 rounded-lg bg-dd-green text-white text-xs font-bold disabled:opacity-40 active:scale-95">
                            {generating ? tx('Working…', 'Trabajando…') : tx('⚡ Generate today now', '⚡ Generar hoy ahora')}
                        </button>
                    </div>
                </div>
            )}

            {daySheet && (
                <DaySheet
                    dateStr={daySheet}
                    rules={activeRules}
                    isEs={isEs} tx={tx}
                    staffName={staffName}
                    staffList={staffList}
                    storeLocation={calLoc}
                    onEdit={(rule) => { setEditRule({ rule, date: daySheet }); }}
                    onClose={() => setDaySheet(null)}
                />
            )}

            {editRule && (
                <RuleEditor
                    rule={editRule.rule}
                    date={editRule.date}
                    isEs={isEs} tx={tx}
                    staffList={staffList}
                    onArmMove={() => {
                        setMoveArm({ rule: editRule.rule, fromDate: editRule.date });
                        setEditRule(null); setDaySheet(null);
                    }}
                    onClose={() => setEditRule(null)}
                />
            )}
        </div>
    );
}

// ── Day sheet — the day's due tasks + the add form ─────────────────────
function DaySheet({ dateStr, rules, isEs, tx, staffName, staffList, storeLocation, onEdit, onClose }) {
    const due = rulesDueOn(rules, dateStr);
    const wd = weekdayOf(dateStr);
    const dayTitle = `${(isEs ? WD_ES : WD_EN)[wd]} ${Number(dateStr.slice(8))}/${Number(dateStr.slice(5, 7))}`;

    // The day's Daily Ops checklist (Operations → Tasks tab), with a
    // FOH/BOH toggle (Andrew 2026-07-27). One fetch per (location, day);
    // the side toggle re-filters the same doc client-side.
    const [listSide, setListSide] = useState('FOH');
    const [listLoc, setListLoc] = useState(storeLocation === 'maryland' ? 'maryland' : 'webster');
    const [dayList, setDayList] = useState(null); // null = loading; {missing} | {customTasks, checks}
    const [listRefresh, setListRefresh] = useState(0); // bumped after an edit/delete
    const [recurEdit, setRecurEdit] = useState(null);  // task whose ✏️ which-days popover is open
    const [opsDirty, setOpsDirty] = useState(0);       // unsaved inline row edits (the ← must warn)
    const [refetching, setRefetching] = useState(false); // refresh in flight, list stays mounted
    const listCtxRef = useRef(null);                   // last (store|day) actually fetched
    const todayStr = toDateStr();
    useEffect(() => {
        let alive = true;
        // 2026-07-30 DATA LOSS: this used to setDayList(null) on EVERY dep
        // change — including a listRefresh bump from saveAll / drag commit /
        // delete / recurrence save. null renders the "Loading…" branch, which
        // UNMOUNTS <OpsEditableList> and destroys its buffered `drafts`, so a
        // single drag wiped every typed-but-unsaved row (and saveAll's
        // deliberate keep-failed-rows-dirty retry set) while the toast said
        // it saved. Only a REAL context switch (day / store) may blank the
        // list now; a refresh keeps the current list mounted mid-refetch.
        const ctx = `${listLoc}|${dateStr}`;
        if (listCtxRef.current !== ctx) {
            listCtxRef.current = ctx;
            setDayList(null);
        }
        setRefetching(true);
        fetchOpsChecklistDay(listLoc, dateStr)
            .then(d => { if (alive) setDayList(d); })
            .catch(() => { if (alive) setDayList({ missing: true }); })
            .finally(() => { if (alive) setRefetching(false); });
        return () => { alive = false; };
    }, [dateStr, listLoc, listRefresh]);
    const listTasks = (dayList && !dayList.missing)
        ? checklistTasksForDay(dayList.customTasks, dayList.checks, listSide, dateStr)
        : [];

    // Add form state
    const [task, setTask] = useState('');
    const [side, setSide] = useState('FOH');
    const [assignee, setAssignee] = useState('');
    const [repeat, setRepeat] = useState('once'); // once | daily | every2 | everyN | weekly
    const [everyN, setEveryN] = useState(3);
    const [weekdays, setWeekdays] = useState(() => [wd]);
    const [busy, setBusy] = useState(false);

    const sideStaff = useMemo(() => (
        (staffList || [])
            .filter(s => s?.name && s.active !== false && (inferStaffSide(s) === side || !inferStaffSide(s)))
            .map(s => ({ id: s.id, name: s.name }))
            .sort((a, b) => a.name.localeCompare(b.name))
    ), [staffList, side]);

    // Assignee options for the Daily Ops inline rows — follows the LIST's
    // side toggle (not the add form's side).
    const listStaff = useMemo(() => (
        (staffList || [])
            .filter(s => s?.name && s.active !== false && (inferStaffSide(s) === listSide || !inferStaffSide(s)))
            .map(s => s.name)
            .sort((a, b) => a.localeCompare(b))
    ), [staffList, listSide]);

    // 2026-07-30: switching FOH/BOH or store re-keys <OpsEditableList>, which
    // DROPS its buffered row drafts by design (they'd otherwise be written to
    // the wrong side/store). That drop used to be completely silent — warn
    // first, same contract as the ← back guard.
    const confirmDropDrafts = () => opsDirty <= 0 || window.confirm(tx(
        'You have unsaved list changes — switching will discard them. Continue?',
        'Tienes cambios sin guardar en la lista — cambiar los descartará. ¿Continuar?'));

    const add = async () => {
        const text = task.trim();
        if (!text || busy) return;
        // Assignee optional (Andrew 2026-07-27) — blank = unassigned task,
        // shows in the 📥 Unassigned column on the Tasks page until a
        // manager hands it to someone (or just checks it off).
        const who = sideStaff.find(s => s.name === assignee) || null;
        const recurrence =
            repeat === 'daily'  ? { type: 'daily', anchor: dateStr } :
            repeat === 'every2' ? { type: 'everyN', n: 2, anchor: dateStr } :
            repeat === 'everyN' ? { type: 'everyN', n: Math.max(2, Math.min(60, Number(everyN) || 3)), anchor: dateStr } :
            repeat === 'weekly' ? { type: 'weekly', weekdays: weekdays.length ? weekdays : [wd], anchor: dateStr } :
                                  { type: 'once', date: dateStr };
        setBusy(true);
        try {
            await createTaskPlanRule({
                task: text, side,
                assignTo: who ? { staffId: who.id ?? null, staffName: who.name } : null,
                recurrence, createdBy: staffName,
            });
            setTask('');
            toast(tx('✓ Planned', '✓ Planificada'), { kind: 'success' });
        } catch (e) {
            toast(tx('Could not save: ', 'No se pudo guardar: ') + (e?.message || ''), { kind: 'error' });
        } finally { setBusy(false); }
    };

    // Full-page takeover (Andrew 2026-07-27: "make the popup window a new
    // page so we can see everything · a back arrow that reminds to save").
    // The ← is the ONLY way out (no backdrop-tap), and it warns when the
    // add form holds a typed-but-unplanned task.
    const handleBack = () => {
        // 2026-07-29: also guards the Daily Ops list's buffered inline
        // edits ("make sure there is a save at the bottom") — leaving
        // without tapping 💾 would silently drop them.
        if (task.trim() || opsDirty > 0) {
            const ok = window.confirm(opsDirty > 0
                ? tx('You have unsaved list changes — leave anyway?',
                    'Tienes cambios sin guardar en la lista — ¿salir de todos modos?')
                : tx('You typed a task but haven\'t planned it yet — leave anyway?',
                    'Escribiste una tarea pero no la has planificado — ¿salir de todos modos?'));
            if (!ok) return;
        }
        onClose();
    };

    return (
        <ModalPortal>
        <div className="fixed inset-0 z-[60] bg-dd-bg flex flex-col">
            <div className="bg-white border-b border-dd-line px-3 py-3 flex items-center gap-2 shrink-0">
                <button onClick={handleBack} aria-label={tx('Back', 'Atrás')}
                    className="w-10 h-10 rounded-full hover:bg-dd-bg active:scale-95 flex items-center justify-center text-xl font-bold text-dd-text">←</button>
                <h3 className="text-base font-black text-dd-text">🗓 {dayTitle}</h3>
            </div>
            <div className="flex-1 overflow-y-auto">
                <div className="max-w-2xl mx-auto p-4 space-y-4 pb-bottom-nav">
                    <div>
                        <div className="flex items-center justify-between gap-2 mb-1.5 flex-wrap">
                            <div className="text-[11px] font-bold uppercase tracking-widest text-dd-text-2">
                                📋 {tx('Daily Ops list', 'Lista de Ops diaria')}{dayList && !dayList.missing ? ` · ${listTasks.filter(t => t.done).length}/${listTasks.length}` : ''}
                                {refetching && dayList !== null && <span className="ml-1 font-normal normal-case">↻</span>}
                            </div>
                            <div className="flex items-center gap-1">
                                {['FOH', 'BOH'].map(s => (
                                    <button key={s} onClick={() => { if (s !== listSide && confirmDropDrafts()) setListSide(s); }}
                                        className={`px-2 py-1 rounded-md text-[11px] font-bold border ${listSide === s
                                            ? (s === 'BOH' ? 'bg-blue-600 text-white border-blue-600' : 'bg-emerald-600 text-white border-emerald-600')
                                            : 'bg-white text-dd-text-2 border-dd-line'}`}>
                                        {s}
                                    </button>
                                ))}
                                <button onClick={() => { if (confirmDropDrafts()) setListLoc(l => l === 'webster' ? 'maryland' : 'webster'); }}
                                    className="px-2 py-1 rounded-md text-[11px] font-bold border bg-white text-dd-text-2 border-dd-line"
                                    title={tx('Switch store', 'Cambiar tienda')}>
                                    {listLoc === 'webster' ? '📍 Webster' : '📍 Maryland'}
                                </button>
                            </div>
                        </div>
                        {dayList === null ? (
                            <p className="text-xs text-dd-text-2 italic">{tx('Loading…', 'Cargando…')}</p>
                        ) : dayList.missing ? (
                            <p className="text-xs text-dd-text-2 italic">{tx('No saved list for this day.', 'No hay lista guardada de este día.')}</p>
                        ) : listTasks.length === 0 ? (
                            <p className="text-xs text-dd-text-2 italic">{tx('No tasks on this list for this day.', 'Sin tareas en esta lista para este día.')}</p>
                        ) : dateStr >= todayStr ? (
                            // Inline editors (Andrew 2026-07-29) — today/future only.
                            // Key on (store, side, day) so switching context drops
                            // any buffered drafts instead of writing them elsewhere.
                            <OpsEditableList key={`${listLoc}|${listSide}|${dateStr}`}
                                tasks={listTasks} listLoc={listLoc} sideStaff={listStaff}
                                isEs={isEs} tx={tx}
                                onChanged={() => setListRefresh(n => n + 1)}
                                onEditRecur={setRecurEdit}
                                onDirtyChange={setOpsDirty} />
                        ) : (
                            <div className="space-y-1">
                                {listTasks.map(t => (
                                    // Past days are archive — read-only ✓/○ rows.
                                    <div key={t.id}
                                        className={`w-full text-left px-2.5 py-1.5 rounded-lg border border-dd-line ${t.done ? 'bg-emerald-50/60' : 'bg-white'}`}>
                                        <div className="flex items-center gap-1.5">
                                            <span className={t.done ? 'text-emerald-600' : 'text-dd-text-2'}>{t.done ? '✓' : '○'}</span>
                                            <span className={`text-sm flex-1 ${t.done ? 'text-dd-text-2 line-through' : 'text-dd-text font-medium'}`}>{t.task}</span>
                                            {t.subCount > 0 && (
                                                <span className="text-[10px] text-dd-text-2">{t.subsDone}/{t.subCount}</span>
                                            )}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>

                    <div>
                        <div className="text-[11px] font-bold uppercase tracking-widest text-dd-text-2 mb-1">
                            {tx('Planned this day', 'Planificado este día')} · {due.length}
                        </div>
                        {due.length === 0 ? (
                            <p className="text-xs text-dd-text-2 italic">{tx('Nothing planned yet.', 'Nada planificado aún.')}</p>
                        ) : (
                            <div className="space-y-1">
                                {due.map(r => (
                                    <button key={r.id} onClick={() => onEdit(r)}
                                        className="w-full text-left px-2.5 py-2 rounded-lg border border-dd-line bg-dd-bg/40 hover:bg-dd-bg active:scale-[0.99]">
                                        <div className="flex items-center gap-1.5 flex-wrap">
                                            <span className="text-sm font-bold text-dd-text">{r.task}</span>
                                            <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${r.side === 'BOH' ? 'bg-blue-100 text-blue-900' : 'bg-emerald-100 text-emerald-900'}`}>{r.side}</span>
                                        </div>
                                        <div className="text-[10px] text-dd-text-2 mt-0.5">
                                            {recurrenceLabel(r, isEs)} · → {r.assignTo?.staffName || tx('📥 unassigned', '📥 sin asignar')}
                                        </div>
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>

                    <div className="pt-2 border-t border-dashed border-dd-line">
                        <div className="text-[11px] font-bold uppercase tracking-widest text-dd-text-2 mb-1.5">
                            ＋ {tx('Add a task starting this day', 'Agregar tarea desde este día')}
                        </div>
                        <GrowingText value={task} onChange={e => setTask(e.target.value.replace(/\r?\n/g, ' '))}
                            placeholder={tx('e.g. Clean the table bases', 'ej. Limpiar bases de mesas')}
                            className="w-full px-3 py-2 rounded-lg border border-dd-line text-base mb-2" />
                        <div className="grid grid-cols-2 gap-2 mb-2">
                            <select value={side} onChange={e => { setSide(e.target.value); setAssignee(''); }}
                                className="px-2 py-2 rounded-lg border border-dd-line bg-white text-sm font-bold">
                                <option value="FOH">FOH</option>
                                <option value="BOH">BOH</option>
                            </select>
                            <select value={assignee} onChange={e => setAssignee(e.target.value)}
                                className="px-2 py-2 rounded-lg border border-dd-line bg-white text-sm">
                                <option value="">{tx('📥 No one (main list)', '📥 Nadie (lista principal)')}</option>
                                {sideStaff.map(s => <option key={s.name} value={s.name}>{s.name}</option>)}
                            </select>
                        </div>
                        <div className="flex flex-wrap gap-1.5 mb-2">
                            {[
                                ['once',   tx('Just this day', 'Solo este día')],
                                ['daily',  tx('Every day', 'Diario')],
                                ['every2', tx('Every other day', 'Cada 2 días')],
                                ['everyN', tx('Every N days', 'Cada N días')],
                                ['weekly', tx('Weekly', 'Semanal')],
                            ].map(([v, label]) => (
                                <button key={v} type="button" onClick={() => setRepeat(v)}
                                    className={`px-2.5 py-1.5 rounded-full text-xs font-bold border ${repeat === v
                                        ? 'bg-dd-green text-white border-dd-green'
                                        : 'bg-white text-dd-text-2 border-dd-line'}`}>
                                    {label}
                                </button>
                            ))}
                        </div>
                        {repeat === 'everyN' && (
                            <label className="flex items-center gap-2 text-xs text-dd-text-2 mb-2">
                                {tx('Every', 'Cada')}
                                <input type="number" min={2} max={60} value={everyN}
                                    onChange={e => setEveryN(e.target.value)}
                                    className="w-16 px-2 py-1 rounded border border-dd-line text-center text-base font-bold" />
                                {tx('days', 'días')}
                            </label>
                        )}
                        {repeat === 'weekly' && (
                            <div className="flex gap-1 mb-2">
                                {(isEs ? WD_ES : WD_EN).map((label, i) => (
                                    <button key={i} type="button"
                                        onClick={() => setWeekdays(w => w.includes(i) ? w.filter(x => x !== i) : [...w, i])}
                                        className={`flex-1 py-1.5 rounded text-[11px] font-bold border ${weekdays.includes(i)
                                            ? 'bg-dd-green text-white border-dd-green'
                                            : 'bg-white text-dd-text-2 border-dd-line'}`}>
                                        {label}
                                    </button>
                                ))}
                            </div>
                        )}
                        <button onClick={add} disabled={busy || !task.trim()}
                            className="w-full py-2.5 rounded-xl bg-dd-green text-white font-bold text-sm disabled:opacity-40 active:scale-95">
                            {busy ? tx('Saving…', 'Guardando…') : tx('＋ Plan it', '＋ Planificar')}
                        </button>
                    </div>
                </div>
            </div>
        </div>
        {recurEdit && (
            <OpsRecurrenceEditor
                task={recurEdit} location={listLoc} isEs={isEs} tx={tx}
                onSaved={() => { setRecurEdit(null); setListRefresh(n => n + 1); }}
                onClose={() => setRecurEdit(null)}
            />
        )}
        </ModalPortal>
    );
}

// ── Inline-edit the Daily Ops checklist from the planner ───────────────
// (Andrew 2026-07-29: "make each task have the text editable right there
// … add who to assign to, what time … make the whole task list moveable"
// + "keep the pencil … just to give the task rules" + "make sure there
// is a save at the bottom".) All writes still go through the transaction
// helpers in taskPlan.js (one period array via dot-path — never the whole
// doc); the Operations page live-updates on its own.
//
// SAVE MODEL: structural ops (drag reorder, 🗑 delete, ✏️ which-days)
// commit IMMEDIATELY; the three field edits (text / assignee / time)
// BUFFER into per-row drafts until the 💾 button at the bottom — Andrew
// wants an explicit save for typing.

// Drafts: { [taskId]: { task?, assignTo?, completeBy? } } — only the
// fields the user touched (assignTo buffered as the ONE selected name; ''
// = unassigned). A field snaps OUT of its draft when edited back to the
// saved value, so the dirty ring / Save button stay honest.
function OpsEditableList({ tasks, listLoc, sideStaff, isEs, tx, onChanged, onEditRecur, onDirtyChange }) {
    const ids = useMemo(() => tasks.map(t => t.id), [tasks]);
    const idsKey = ids.join('|');
    const byId = useMemo(() => Object.fromEntries(tasks.map(t => [t.id, t])), [tasks]);

    // Local display order (drag reorders it live); reset whenever the
    // fetched row set — or its saved order — changes.
    const [order, setOrder] = useState(ids);
    const orderRef = useRef(ids);
    const applyOrder = (next) => { orderRef.current = next; setOrder(next); };
    useEffect(() => { applyOrder(ids); }, [idsKey]); // eslint-disable-line react-hooks/exhaustive-deps

    const [drafts, setDrafts] = useState({});
    const [saving, setSaving] = useState(false);
    // assignTo is an ARRAY of names (Andrew 2026-08-19: "assign a task to
    // multiple people"); compared by joined value.
    const fieldBase = (t, field) =>
        field === 'task' ? (t.task || '')
            : field === 'assignTo' ? (Array.isArray(t.assignTo) ? t.assignTo : [])
                : field === 'assignDays' ? (t.assignDays || {})
                    : (t.completeBy || '');
    const setField = (id, field, value) => {
        setDrafts(prev => {
            const t = byId[id];
            const row = { ...(prev[id] || {}) };
            const base = t ? fieldBase(t, field) : (field === 'assignTo' ? [] : '');
            const same = field === 'task' ? value.trim() === base.trim()
                : field === 'assignTo' ? [...(value || [])].join('\u0001') === [...(base || [])].join('\u0001')
                : field === 'assignDays' ? JSON.stringify(value || {}) === JSON.stringify(base || {})
                : value === base;
            if (same) delete row[field]; else row[field] = value;
            const next = { ...prev };
            if (Object.keys(row).length === 0) delete next[id]; else next[id] = row;
            return next;
        });
    };
    const dirtyCount = Object.keys(drafts).length;
    useEffect(() => { onDirtyChange?.(dirtyCount); }, [dirtyCount]); // eslint-disable-line react-hooks/exhaustive-deps
    useEffect(() => () => onDirtyChange?.(0), []); // eslint-disable-line react-hooks/exhaustive-deps

    // 💾 commit every dirty row (Andrew 2026-07-29: explicit save for
    // typing). Rows that fail STAY dirty for a retry.
    const saveAll = async () => {
        if (saving || dirtyCount === 0) return;
        setSaving(true);
        const failed = {};
        let firstErr = null;
        let blankName = false;
        for (const [id, d] of Object.entries(drafts)) {
            const patch = {};
            if ('task' in d) {
                // 2026-07-30: an EMPTIED name used to yield an empty patch —
                // the write was skipped, the draft cleared, and the toast said
                // "✓ Saved" while the old text reappeared on the next fetch.
                // Blank is a validation failure: keep the row dirty so the
                // manager can see + fix it (trim before writing, too).
                const text = d.task.trim();
                if (!text) { failed[id] = d; blankName = true; continue; }
                patch.task = text;
            }
            // Full assignee list ([] = unassign).
            if ('assignTo' in d) patch.assignTo = Array.isArray(d.assignTo) ? d.assignTo : [];
            if ('assignDays' in d) patch.assignDays = d.assignDays || {};
            if ('completeBy' in d) patch.completeBy = d.completeBy; // '' = remove
            try {
                if (Object.keys(patch).length) await updateOpsChecklistTask(listLoc, id, patch);
            } catch (e) { failed[id] = d; firstErr = firstErr || e; }
        }
        setDrafts(failed);
        setSaving(false);
        if (firstErr) {
            toast(tx('Some changes did not save: ', 'Algunos cambios no se guardaron: ') + (firstErr?.message || ''), { kind: 'error' });
        }
        if (blankName) {
            toast(tx('Task name can\'t be empty — that row was not saved',
                'El nombre no puede estar vacío — esa fila no se guardó'), { kind: 'error' });
        }
        if (!firstErr && !blankName) {
            toast(tx('✓ Saved', '✓ Guardado'), { kind: 'success' });
        }
        onChanged();
    };

    // ── Drag-to-reorder (pointer events — HTML5 DnD is broken on iPad
    // Safari). Heights are measured ONCE at drag start; the neighbor whose
    // vertical midpoint the pointer crosses swaps live in `order`.
    const rowEls = useRef({});
    const dragRef = useRef(null);
    const [drag, setDrag] = useState(null); // { id, dy } while a row is held
    const GAP = 4; // space-y-1

    const onHandleDown = (e, id) => {
        if (dragRef.current) return;
        e.preventDefault();
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* older Safari */ }
        const heights = {};
        for (const tid of orderRef.current) {
            const el = rowEls.current[tid];
            heights[tid] = (el ? el.getBoundingClientRect().height : 40) + GAP;
        }
        dragRef.current = { id, startY: e.clientY, startOrder: [...orderRef.current], heights };
        setDrag({ id, dy: 0 });
    };

    useEffect(() => {
        if (!drag) return undefined;
        // Window-level listeners: pointer capture alone can drop when the
        // captured node is re-parented by the live reorder.
        const newOrderFor = (dy) => {
            const d = dragRef.current;
            const others = d.startOrder.filter(x => x !== d.id);
            let top = 0;
            for (const tid of d.startOrder) { if (tid === d.id) break; top += d.heights[tid]; }
            const center = top + dy + d.heights[d.id] / 2;
            let idx = 0, y = 0;
            for (const oid of others) {
                if (center > y + d.heights[oid] / 2) idx++;
                y += d.heights[oid];
            }
            const next = [...others];
            next.splice(idx, 0, d.id);
            return next;
        };
        const onMove = (e) => {
            const d = dragRef.current;
            if (!d) return;
            const dy = e.clientY - d.startY;
            const next = newOrderFor(dy);
            if (next.join('|') !== orderRef.current.join('|')) applyOrder(next);
            setDrag({ id: d.id, dy });
        };
        const finish = async (commit) => {
            const d = dragRef.current;
            if (!d) return;
            dragRef.current = null;
            setDrag(null);
            if (!commit) { applyOrder(d.startOrder); return; }
            const final = orderRef.current;
            if (final.join('|') === d.startOrder.join('|')) return;
            // ORDER SEMANTICS: this list is DAY-FILTERED by recurrence, so
            // the on-screen next row may not be array-adjacent in Firestore.
            // Insert-BEFORE-that-row's-id (end = push) is correct either way.
            const beforeId = final[final.indexOf(d.id) + 1] ?? null;
            try {
                await moveOpsChecklistTask(listLoc, d.id, beforeId);
                onChanged();
            } catch (err) {
                applyOrder(d.startOrder);
                toast(tx('Reorder failed: ', 'Error al reordenar: ') + (err?.message || ''), { kind: 'error' });
            }
        };
        const onUp = () => { finish(true); };
        const onCancel = () => { finish(false); };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onCancel);
        return () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            window.removeEventListener('pointercancel', onCancel);
        };
    }, [drag ? drag.id : null]); // eslint-disable-line react-hooks/exhaustive-deps

    // Keep the held row under the finger: raw dy minus however far the
    // live reorder already moved it within the layout.
    let dragOffset = 0;
    if (drag && dragRef.current) {
        const d = dragRef.current;
        const topIn = (ord) => { let y = 0; for (const tid of ord) { if (tid === d.id) break; y += d.heights[tid]; } return y; };
        dragOffset = drag.dy - (topIn(order) - topIn(d.startOrder));
    }

    const remove = async (t) => {
        if (!window.confirm(tx(`Delete "${t.task}" from the list?`, `¿Eliminar "${t.task}" de la lista?`))) return;
        try {
            await deleteOpsChecklistTask(listLoc, t.id);
            setDrafts(prev => { const next = { ...prev }; delete next[t.id]; return next; });
            toast(tx('✓ Deleted', '✓ Eliminada'), { kind: 'success' });
            onChanged();
        } catch (e) {
            toast(tx('Failed: ', 'Error: ') + (e?.message || ''), { kind: 'error' });
        }
    };

    return (
        <div>
            <div className="space-y-1">
                {order.map(id => byId[id]).filter(Boolean).map(t => (
                    <OpsEditableRow key={t.id} t={t} draft={drafts[t.id]} sideStaff={sideStaff}
                        isEs={isEs} tx={tx}
                        onField={setField} onEditRecur={onEditRecur} onDelete={remove}
                        dragging={drag?.id === t.id}
                        dragOffset={drag?.id === t.id ? dragOffset : 0}
                        onHandleDown={onHandleDown}
                        rowRef={(el) => { rowEls.current[t.id] = el; }} />
                ))}
            </div>
            <button onClick={saveAll} disabled={saving || dirtyCount === 0}
                className="sticky bottom-2 z-20 w-full mt-2 py-2.5 rounded-xl bg-dd-green text-white font-bold text-sm shadow disabled:opacity-40 active:scale-95">
                {saving ? tx('Saving…', 'Guardando…') : tx('💾 Save changes', '💾 Guardar cambios')}
            </button>
        </div>
    );
}

// One inline row: ≡ drag · ✓/○ · text · 👤 assignee · 🕐 time · ✏️ · 🗑.
// Controls wrap under the text on narrow screens (flex-wrap — the sheet
// is a full-screen takeover so there's room).
function OpsEditableRow({ t, draft, sideStaff, isEs, tx, onField, onEditRecur, onDelete, dragging, dragOffset, onHandleDown, rowRef }) {
    const dirty = !!draft;
    const text = draft && 'task' in draft ? draft.task : (t.task || '');
    const who = draft && 'assignTo' in draft ? (draft.assignTo || []) : (Array.isArray(t.assignTo) ? t.assignTo : []);
    const whoDays = draft && 'assignDays' in draft ? (draft.assignDays || {}) : (t.assignDays || {});
    const time = draft && 'completeBy' in draft ? draft.completeBy : (t.completeBy || '');
    const [pickOpen, setPickOpen] = useState(false);
    const firstNames = who.map(n => String(n).split(' ')[0]);
    const whoLabel = who.length === 0 ? '👤 —'
        : who.length <= 2 ? `👤 ${firstNames.join(', ')}`
        : `👤 ${firstNames.slice(0, 2).join(', ')} +${who.length - 2}`;
    return (
        <div ref={rowRef}
            className={`px-2 py-1.5 rounded-lg border ${dirty ? 'border-amber-300 ring-1 ring-amber-300' : 'border-dd-line'} ${
                t.done ? 'bg-emerald-50/60' : 'bg-white'} ${dragging ? 'relative z-10 shadow-lg' : ''}`}
            style={dragging ? { transform: `translateY(${dragOffset}px)` } : undefined}>
            {/* pointer-events-none while dragged so the inputs can't swallow
                the gesture; the handle re-enables itself to keep capture. */}
            <div className={`flex items-center gap-1.5 flex-wrap ${dragging ? 'pointer-events-none' : ''}`}>
                <span onPointerDown={(e) => onHandleDown(e, t.id)}
                    aria-label={tx('Drag to reorder', 'Arrastra para reordenar')}
                    className="cursor-grab select-none text-dd-text-2 text-lg leading-none px-1 -ml-0.5"
                    style={{ touchAction: 'none', pointerEvents: 'auto' }}>≡</span>
                <span className={t.done ? 'text-emerald-600' : 'text-dd-text-2'}>{t.done ? '✓' : '○'}</span>
                <GrowingText value={text}
                    onChange={(e) => onField(t.id, 'task', e.target.value.replace(/\r?\n/g, ' '))}
                    aria-label={tx('Task text', 'Texto de la tarea')}
                    className={`flex-1 min-w-[10rem] text-sm px-1.5 py-1 rounded-md border border-transparent focus:border-dd-line focus:bg-white bg-transparent ${
                        t.done ? 'text-dd-text-2 line-through' : 'text-dd-text font-medium'}`} />
                {t.subCount > 0 && <span className="text-[10px] text-dd-text-2">{t.subsDone}/{t.subCount}</span>}
                <div className="flex items-center gap-1 ml-auto">
                    <button type="button" onClick={() => setPickOpen(true)}
                        title={who.length ? who.join(', ') : tx('Assign to', 'Asignar a')}
                        className={`max-w-[9rem] truncate px-1.5 py-1 rounded-md border text-[11px] text-left ${who.length ? 'border-dd-line bg-white text-dd-text font-bold' : 'border-dd-line bg-white text-dd-text-2'}`}>
                        {whoLabel}
                    </button>
                    {pickOpen && (
                        <AssigneePicker
                            value={who} days={whoDays} options={sideStaff} taskText={t.task} isEs={isEs} tx={tx}
                            onChange={(next) => onField(t.id, 'assignTo', next)}
                            onChangeDays={(nextDays) => onField(t.id, 'assignDays', nextDays)}
                            onClose={() => setPickOpen(false)} />
                    )}
                    <input type="time" value={time}
                        onChange={(e) => onField(t.id, 'completeBy', e.target.value)}
                        title={tx('Complete by', 'Completar antes de')}
                        className="px-1.5 py-1 rounded-md border border-dd-line bg-white text-[11px]" />
                    {(t.recurrence && t.recurrence !== 'daily') && (
                        <button onClick={() => onEditRecur(t)} title={tx('Which days', 'Qué días')}
                            className="max-w-[6.5rem] truncate text-[9px] font-bold px-1.5 py-1 rounded-md bg-cyan-100 text-cyan-800 border border-cyan-300">
                            🔁 {recurrenceLabelFor(t, isEs ? 'es' : 'en')}
                        </button>
                    )}
                    <button onClick={() => onEditRecur(t)} title={tx('Which days', 'Qué días')}
                        className="w-7 h-7 rounded-md border border-dd-line bg-white text-[12px] active:scale-95">✏️</button>
                    <button onClick={() => onDelete(t)} title={tx('Delete', 'Eliminar')}
                        className="w-7 h-7 rounded-md border border-red-200 bg-white text-[12px] active:scale-95">🗑</button>
                </div>
            </div>
        </div>
    );
}

// ── Reusable which-days chooser (weekday toggles / mini calendar) ───────
// Shared by the task-level ✏️ editor and the per-person schedule editor.
function DaysPicker({ mode, days, dates, onDays, onDates, isEs, tx }) {
    const [calAnchor, setCalAnchor] = useState(() => toDateStr().slice(0, 8) + '01');
    const todayStr = toDateStr();
    const WD = isEs ? WD_ES : WD_EN;
    const toggleDay = (d) => onDays(days.includes(d) ? days.filter(x => x !== d) : [...days, d].sort((a, b) => a - b));
    const toggleDate = (ds) => onDates(dates.includes(ds) ? dates.filter(x => x !== ds) : [...dates, ds].sort());
    const calCells = useMemo(() => {
        const [y, m] = calAnchor.split('-').map(Number);
        const n = new Date(y, m, 0).getDate();
        const lead = weekdayOf(calAnchor);
        const out = [];
        for (let i = 0; i < lead; i++) out.push(null);
        for (let d = 1; d <= n; d++) out.push(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
        return out;
    }, [calAnchor]);
    const shiftCal = (delta) => {
        const [y, m] = calAnchor.split('-').map(Number);
        const d = new Date(Date.UTC(y, m - 1 + delta, 1, 12));
        setCalAnchor(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`);
    };
    const calTitle = (() => { const [y, m] = calAnchor.split('-').map(Number); return `${(isEs ? MONTHS_ES : MONTHS_EN)[m - 1]} ${y}`; })();
    if (mode === 'days') {
        return (
            <div>
                <div className="grid grid-cols-7 gap-1">
                    {WD.map((label, d) => (
                        <button key={d} type="button" onClick={() => toggleDay(d)}
                            className={`py-2 rounded-lg text-xs font-bold border ${days.includes(d) ? 'bg-dd-green text-white border-dd-green' : 'bg-white text-dd-text border-dd-line'}`}>
                            {label}
                        </button>
                    ))}
                </div>
                <div className="flex gap-1 mt-2 flex-wrap">
                    <button type="button" onClick={() => onDays([1, 2, 3, 4, 5])} className="text-[11px] font-bold px-2 py-1 rounded-full bg-dd-bg">{tx('Mon–Fri', 'Lun–Vie')}</button>
                    <button type="button" onClick={() => onDays([0, 6])} className="text-[11px] font-bold px-2 py-1 rounded-full bg-dd-bg">{tx('Sat–Sun', 'Sáb–Dom')}</button>
                    <button type="button" onClick={() => onDays([])} className="text-[11px] font-bold px-2 py-1 rounded-full bg-dd-bg">{tx('Clear', 'Limpiar')}</button>
                </div>
                <p className="text-[11px] text-dd-text-2 mt-2">{tx('Every week on the ticked days.', 'Cada semana en los días marcados.')}</p>
            </div>
        );
    }
    if (mode === 'dates') {
        return (
            <div>
                <div className="flex items-center justify-between mb-1">
                    <button type="button" onClick={() => shiftCal(-1)} className="px-3 py-1 rounded-lg bg-dd-bg font-bold">‹</button>
                    <div className="text-sm font-black text-dd-text">{calTitle}</div>
                    <button type="button" onClick={() => shiftCal(1)} className="px-3 py-1 rounded-lg bg-dd-bg font-bold">›</button>
                </div>
                <div className="grid grid-cols-7 gap-1 text-center text-[10px] font-bold uppercase text-dd-text-2 mb-1">
                    {WD.map(d => <div key={d}>{d}</div>)}
                </div>
                <div className="grid grid-cols-7 gap-1">
                    {calCells.map((ds, i) => ds ? (
                        <button key={ds} type="button" onClick={() => toggleDate(ds)}
                            className={`py-1.5 rounded-lg text-xs font-bold border ${dates.includes(ds) ? 'bg-dd-green text-white border-dd-green' : ds === todayStr ? 'bg-white text-dd-green-700 border-dd-green' : ds < todayStr ? 'bg-white text-dd-text-2/50 border-dd-line' : 'bg-white text-dd-text border-dd-line'}`}>
                            {Number(ds.slice(8))}
                        </button>
                    ) : <div key={`b${i}`} />)}
                </div>
                <div className="flex flex-wrap gap-1 mt-2">
                    {dates.map(ds => (
                        <button key={ds} type="button" onClick={() => toggleDate(ds)} className="text-[11px] font-bold px-2 py-1 rounded-full bg-dd-sage-50 border border-dd-green text-dd-green-700">
                            {Number(ds.slice(5, 7))}/{Number(ds.slice(8))} ✕
                        </button>
                    ))}
                    {dates.length === 0 && <span className="text-[11px] text-dd-text-2 italic">{tx('Tap the days.', 'Toca los días.')}</span>}
                </div>
            </div>
        );
    }
    return null;
}

// 👤 multi-assignee picker (Andrew 2026-08-19: "assign a task to multiple
// people" + "give me the option to change what day that person has that
// task — without changing the whole task"). Bottom sheet with a checkbox
// per staffer; each SELECTED person gets a 📅 schedule line (default =
// every day the task shows) that opens a per-person days editor. Commits
// into the row DRAFTS (assignTo + assignDays), saved with the 💾 button.
function AssigneePicker({ value, days = {}, options, taskText, isEs, tx, onChange, onChangeDays, onClose }) {
    const sel = new Set(value || []);
    // Keep off-side / renamed names visible so a stray tap never silently drops them.
    const all = [...new Set([...(value || []), ...options])];
    const [personEdit, setPersonEdit] = useState(null); // name whose schedule is being edited
    const toggle = (n) => {
        const next = new Set(sel);
        if (next.has(n)) next.delete(n); else next.add(n);
        const nextList = all.filter(x => next.has(x));
        onChange(nextList);
        // Schedules only for current assignees (keep raw shapes here — the
        // save path normalizes; normalizing mid-edit would drop a mode the
        // user just picked but hasn't filled with days yet).
        const pruned = {};
        for (const [k, v] of Object.entries(days || {})) if (nextList.includes(k)) pruned[k] = v;
        if (JSON.stringify(pruned) !== JSON.stringify(days)) onChangeDays(pruned);
    };
    const schedLabel = (n) => {
        const sc = days[n];
        if (!sc || sc.recurrence === 'daily') return tx('every day of the task', 'cada día de la tarea');
        return recurrenceLabelFor(sc, isEs ? 'es' : 'en');
    };

    // ── per-person schedule sub-editor ──
    if (personEdit) {
        const sc = days[personEdit] || null;
        const mode = sc?.recurrence === 'days' ? 'days' : sc?.recurrence === 'dates' ? 'dates' : 'same';
        const setSched = (next) => {
            const map = { ...days };
            if (next) map[personEdit] = next; else delete map[personEdit];
            onChangeDays(map);
        };
        const modeBtn = (id, label) => (
            <button key={id} type="button"
                onClick={() => {
                    if (id === 'same') setSched(null);
                    else if (id === 'days') setSched({ recurrence: 'days', recurDays: sc?.recurDays || [] });
                    else setSched({ recurrence: 'dates', recurDates: sc?.recurDates || [] });
                }}
                className={`flex-1 px-2 py-2 rounded-lg text-xs font-bold border ${mode === id ? 'bg-dd-green text-white border-dd-green' : 'bg-white text-dd-text-2 border-dd-line'}`}>
                {label}
            </button>
        );
        return (
            <ModalPortal onBackPress={() => setPersonEdit(null)}>
            <div className="fixed inset-0 z-[70] bg-black/50 flex items-end sm:items-center justify-center p-0 sm:p-3" onClick={() => setPersonEdit(null)}>
                <div className="bg-white w-full sm:max-w-sm rounded-t-2xl sm:rounded-2xl p-4 space-y-3 max-h-[90vh] overflow-y-auto"
                    onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center justify-between">
                        <h3 className="text-base font-black text-dd-text">📅 {personEdit}</h3>
                        <button onClick={() => setPersonEdit(null)} className="w-8 h-8 rounded-full hover:bg-dd-bg flex items-center justify-center">✕</button>
                    </div>
                    <div className="text-[11px] text-dd-text-2 -mt-2 truncate">{taskText}</div>
                    <p className="text-[11px] text-dd-text-2">{tx('Which days does this person have the task? Only their days change — the task and everyone else stay the same.', '¿Qué días tiene esta persona la tarea? Solo cambian sus días — la tarea y los demás quedan igual.')}</p>
                    <div className="flex gap-1">
                        {modeBtn('same', tx('Every day of the task', 'Cada día de la tarea'))}
                        {modeBtn('days', tx('Days of the week', 'Días de la semana'))}
                        {modeBtn('dates', tx('Calendar days', 'Días del calendario'))}
                    </div>
                    {mode !== 'same' && (
                        <DaysPicker
                            mode={mode}
                            days={sc?.recurDays || []} dates={sc?.recurDates || []}
                            onDays={(d) => setSched({ recurrence: 'days', recurDays: d })}
                            onDates={(d) => setSched({ recurrence: 'dates', recurDates: d })}
                            isEs={isEs} tx={tx} />
                    )}
                    <button onClick={() => setPersonEdit(null)} className="w-full py-2.5 rounded-xl bg-dd-green text-white font-bold text-sm">
                        {tx('← Back to people', '← Volver a personas')}
                    </button>
                </div>
            </div>
            </ModalPortal>
        );
    }

    return (
        <ModalPortal onBackPress={onClose}>
        <div className="fixed inset-0 z-[70] bg-black/50 flex items-end sm:items-center justify-center p-0 sm:p-3" onClick={onClose}>
            <div className="bg-white w-full sm:max-w-sm rounded-t-2xl sm:rounded-2xl p-4 space-y-3 max-h-[85vh] flex flex-col"
                onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center justify-between">
                    <h3 className="text-base font-black text-dd-text">👤 {tx('Assign to', 'Asignar a')}</h3>
                    <button onClick={onClose} className="w-8 h-8 rounded-full hover:bg-dd-bg flex items-center justify-center">✕</button>
                </div>
                <div className="text-[11px] text-dd-text-2 -mt-2 truncate">{taskText}</div>
                <div className="flex gap-1 flex-wrap">
                    <button type="button" onClick={() => { onChange([]); onChangeDays({}); }} className="text-[11px] font-bold px-2 py-1 rounded-full bg-dd-bg">{tx('No one (main list)', 'Nadie (lista principal)')}</button>
                    <button type="button" onClick={() => onChange([...all])} className="text-[11px] font-bold px-2 py-1 rounded-full bg-dd-bg">{tx('Everyone', 'Todos')}</button>
                </div>
                <div className="overflow-y-auto space-y-1 -mx-1 px-1">
                    {all.map(n => (
                        <div key={n} className={`px-2 py-2 rounded-lg border ${sel.has(n) ? 'border-dd-green bg-dd-sage-50/60' : 'border-dd-line'}`}>
                            <label className="flex items-center gap-2 cursor-pointer">
                                <input type="checkbox" checked={sel.has(n)} onChange={() => toggle(n)} className="w-4 h-4 accent-dd-green" />
                                <span className="text-sm font-bold text-dd-text flex-1">{n}</span>
                            </label>
                            {sel.has(n) && (
                                <button type="button" onClick={() => setPersonEdit(n)}
                                    className={`mt-1 ml-6 text-[11px] font-bold px-2 py-1 rounded-full border ${days[n] ? 'bg-cyan-100 text-cyan-800 border-cyan-300' : 'bg-white text-dd-text-2 border-dd-line'}`}>
                                    📅 {schedLabel(n)}
                                </button>
                            )}
                        </div>
                    ))}
                    {all.length === 0 && <p className="text-xs text-dd-text-2 italic">{tx('No staff on this side yet.', 'Aún no hay personal en este lado.')}</p>}
                </div>
                <button onClick={onClose} className="w-full py-2.5 rounded-xl bg-dd-green text-white font-bold text-sm">
                    {tx(`Done · ${sel.size} selected`, `Listo · ${sel.size} seleccionados`)}
                </button>
                <p className="text-[10px] text-dd-text-2 text-center -mt-1">{tx('Saves with the 💾 button at the bottom of the list.', 'Se guarda con el botón 💾 al final de la lista.')}</p>
            </div>
        </div>
        </ModalPortal>
    );
}

// ✏️ popover — which days a Daily Ops task shows (Andrew 2026-07-29 "keep
// the pencil just to give the task rules"; 2026-08-19 "everyday, certain
// days of the week, or certain calendar days"). Three modes; saves
// immediately on 💾. Legacy presets (weekday / monday…) open in the
// "days" mode pre-ticked and re-save as 'days' (same meaning).
const PRESET_TO_DAYS = {
    weekday: [1, 2, 3, 4, 5], weekend: [0, 6],
    sunday: [0], monday: [1], tuesday: [2], wednesday: [3], thursday: [4], friday: [5], saturday: [6],
};
function OpsRecurrenceEditor({ task, location, isEs, tx, onSaved, onClose }) {
    const initial = (() => {
        const r = task.recurrence || 'daily';
        if (r === 'days') return { mode: 'days', days: normalizeRecurDays(task.recurDays), dates: [] };
        if (r === 'dates') return { mode: 'dates', days: [], dates: normalizeRecurDates(task.recurDates) };
        if (PRESET_TO_DAYS[r]) return { mode: 'days', days: PRESET_TO_DAYS[r], dates: [] };
        return { mode: 'daily', days: [], dates: [] };
    })();
    const [mode, setMode] = useState(initial.mode);
    const [days, setDays] = useState(initial.days);
    const [dates, setDates] = useState(initial.dates);
    const [busy, setBusy] = useState(false);

    const save = async () => {
        if (busy) return;
        let patch;
        if (mode === 'daily') patch = { recurrence: 'daily' };
        else if (mode === 'days') {
            if (days.length === 0) { toast(tx('Pick at least one weekday', 'Elige al menos un día'), { kind: 'error' }); return; }
            patch = { recurrence: 'days', recurDays: days };
        } else {
            if (dates.length === 0) { toast(tx('Pick at least one date', 'Elige al menos una fecha'), { kind: 'error' }); return; }
            patch = { recurrence: 'dates', recurDates: dates };
        }
        setBusy(true);
        try {
            await updateOpsChecklistTask(location, task.id, patch);
            toast(tx('✓ Saved', '✓ Guardado'), { kind: 'success' });
            onSaved();
        } catch (e) {
            toast(tx('Failed: ', 'Error: ') + (e?.message || ''), { kind: 'error' });
            setBusy(false);
        }
    };
    const modeBtn = (id, label) => (
        <button key={id} type="button" onClick={() => setMode(id)}
            className={`flex-1 px-2 py-2 rounded-lg text-xs font-bold border ${mode === id ? 'bg-dd-green text-white border-dd-green' : 'bg-white text-dd-text-2 border-dd-line'}`}>
            {label}
        </button>
    );
    return (
        <div className="fixed inset-0 z-[70] bg-black/50 flex items-end sm:items-center justify-center p-0 sm:p-3" onClick={onClose}>
            <div className="bg-white w-full sm:max-w-sm rounded-t-2xl sm:rounded-2xl p-4 space-y-3 max-h-[90vh] overflow-y-auto"
                onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center justify-between">
                    <h3 className="text-base font-black text-dd-text">📅 {tx('Which days', 'Qué días')}</h3>
                    <button onClick={onClose} className="w-8 h-8 rounded-full hover:bg-dd-bg flex items-center justify-center">✕</button>
                </div>
                <div className="text-[11px] text-dd-text-2 -mt-2 truncate">{task.task}</div>
                <div className="flex gap-1">
                    {modeBtn('daily', tx('Every day', 'Cada día'))}
                    {modeBtn('days', tx('Days of the week', 'Días de la semana'))}
                    {modeBtn('dates', tx('Calendar days', 'Días del calendario'))}
                </div>
                {mode !== 'daily' && (
                    <DaysPicker mode={mode} days={days} dates={dates}
                        onDays={setDays} onDates={setDates} isEs={isEs} tx={tx} />
                )}
                <button disabled={busy} onClick={save}
                    className="w-full py-2.5 rounded-xl bg-dd-green text-white font-bold text-sm disabled:opacity-40">
                    {busy ? tx('Saving…', 'Guardando…') : tx('💾 Done', '💾 Listo')}
                </button>
            </div>
        </div>
    );
}

// ── Rule editor — edit / skip / move / end / delete a series ───────────
function RuleEditor({ rule, date, isEs, tx, staffList, onArmMove, onClose }) {
    const [task, setTask] = useState(rule.task || '');
    const [assignee, setAssignee] = useState(rule.assignTo?.staffName || '');
    const [busy, setBusy] = useState(false);
    const isRecurring = rule.recurrence?.type !== 'once';

    const sideStaff = useMemo(() => (
        (staffList || [])
            .filter(s => s?.name && s.active !== false && (inferStaffSide(s) === rule.side || !inferStaffSide(s)))
            .map(s => ({ id: s.id, name: s.name }))
            .sort((a, b) => a.name.localeCompare(b.name))
    ), [staffList, rule.side]);

    const run = async (fn, okMsg) => {
        if (busy) return;
        setBusy(true);
        try {
            await fn();
            if (okMsg) toast(okMsg, { kind: 'success' });
            onClose();
        } catch (e) {
            toast(tx('Failed: ', 'Error: ') + (e?.message || ''), { kind: 'error' });
        } finally { setBusy(false); }
    };

    return (
        <ModalPortal>
        <div className="fixed inset-0 z-[65] bg-black/50 flex items-end sm:items-center justify-center p-0 sm:p-3" onClick={onClose}>
            <div className="bg-white w-full sm:max-w-sm rounded-t-2xl sm:rounded-2xl p-4 space-y-3"
                onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center justify-between">
                    <h3 className="text-base font-black text-dd-text">✏️ {tx('Edit task', 'Editar tarea')}</h3>
                    <button onClick={onClose} className="w-8 h-8 rounded-full hover:bg-dd-bg flex items-center justify-center">✕</button>
                </div>
                <div className="text-[11px] text-dd-text-2 -mt-2">
                    {recurrenceLabel(rule, isEs)} · {rule.side} · {date}
                </div>
                <GrowingText value={task} onChange={e => setTask(e.target.value.replace(/\r?\n/g, ' '))} minRows={2}
                    className="w-full px-3 py-2 rounded-lg border border-dd-line text-base" />
                <select value={assignee} onChange={e => setAssignee(e.target.value)}
                    className="w-full px-2 py-2 rounded-lg border border-dd-line bg-white text-sm">
                    <option value="">{tx('📥 No one (main list)', '📥 Nadie (lista principal)')}</option>
                    {sideStaff.map(s => <option key={s.name} value={s.name}>{s.name}</option>)}
                </select>
                <button disabled={busy || !task.trim()}
                    onClick={() => run(() => {
                        const who = sideStaff.find(s => s.name === assignee) || null;
                        // 2026-07-27 audit R2: when the select still shows the
                        // ORIGINAL assignee but that person dropped out of the
                        // sideStaff pool (side change / rename / deactivated),
                        // `who` resolved null and a plain text edit silently
                        // un-assigned the task. Keep the existing assignTo in
                        // that case — only the explicit 📥 '' option clears it.
                        const keepExisting = !who && assignee
                            && assignee === (rule.assignTo?.staffName || '');
                        return updateTaskPlanRule(rule.id, {
                            task: task.trim(),
                            assignTo: who
                                ? { staffId: who.id ?? null, staffName: who.name }
                                : (keepExisting ? rule.assignTo : null),
                        });
                    }, tx('✓ Saved', '✓ Guardado'))}
                    className="w-full py-2.5 rounded-xl bg-dd-green text-white font-bold text-sm disabled:opacity-40">
                    {tx('💾 Save changes', '💾 Guardar cambios')}
                </button>
                <div className="grid grid-cols-2 gap-2">
                    <button disabled={busy} onClick={onArmMove}
                        className="py-2 rounded-lg bg-white border-2 border-amber-300 text-amber-800 text-xs font-bold">
                        ➡️ {tx('Move this day…', 'Mover este día…')}
                    </button>
                    {isRecurring ? (
                        <button disabled={busy}
                            onClick={() => run(() => skipOccurrence(rule.id, date), tx('✓ Skipped', '✓ Omitido'))}
                            className="py-2 rounded-lg bg-white border-2 border-dd-line text-dd-text-2 text-xs font-bold">
                            ⏭ {tx('Skip this day', 'Omitir este día')}
                        </button>
                    ) : (
                        <button disabled={busy}
                            onClick={() => run(() => archiveTaskPlanRule(rule.id), tx('✓ Removed', '✓ Quitada'))}
                            className="py-2 rounded-lg bg-white border-2 border-red-200 text-red-700 text-xs font-bold">
                            🗑 {tx('Remove', 'Quitar')}
                        </button>
                    )}
                </div>
                {isRecurring && (
                    <div className="grid grid-cols-2 gap-2">
                        <button disabled={busy}
                            onClick={() => {
                                if (!window.confirm(tx('Stop this series from today on? Past days keep their history.',
                                    '¿Terminar esta serie desde hoy? El historial se conserva.'))) return;
                                run(() => updateTaskPlanRule(rule.id, { endDate: addDaysStr(toDateStr(), -1) }),
                                    tx('✓ Series ended', '✓ Serie terminada'));
                            }}
                            className="py-2 rounded-lg bg-white border-2 border-dd-line text-dd-text-2 text-xs font-bold">
                            🛑 {tx('End series', 'Terminar serie')}
                        </button>
                        <button disabled={busy}
                            onClick={() => {
                                if (!window.confirm(tx('Delete this whole series?', '¿Borrar toda la serie?'))) return;
                                run(() => deleteTaskPlanRule(rule.id), tx('✓ Deleted', '✓ Borrada'));
                            }}
                            className="py-2 rounded-lg bg-white border-2 border-red-200 text-red-700 text-xs font-bold">
                            🗑 {tx('Delete series', 'Borrar serie')}
                        </button>
                    </div>
                )}
            </div>
        </div>
        </ModalPortal>
    );
}
