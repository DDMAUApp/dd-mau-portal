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
//   • tap a task chip in the day sheet → edit series, skip this day,
//     move this occurrence (arms move mode → tap the target day), end
//     or delete the series
//   • ⚡ Generate today now — runs the materializer immediately
import { useEffect, useMemo, useState } from 'react';
import {
    subscribeTaskPlan, createTaskPlanRule, updateTaskPlanRule,
    archiveTaskPlanRule, deleteTaskPlanRule, skipOccurrence, moveOccurrence,
    rulesDueOn, ensureMaterializedForToday, toDateStr, addDaysStr, weekdayOf,
} from '../data/taskPlan';
import { inferStaffSide } from '../data/assignedTasks';
import { toast } from '../toast';
import ModalPortal from './ModalPortal';

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

export default function TaskPlanner({ language = 'en', staffName, staffList = [] }) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);

    const [expanded, setExpanded] = useState(false);
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

    const monthTitle = useMemo(() => {
        const [y, m] = monthAnchor.split('-').map(Number);
        return `${(isEs ? MONTHS_ES : MONTHS_EN)[m - 1]} ${y}`;
    }, [monthAnchor, isEs]);

    const shiftMonth = (delta) => {
        const [y, m] = monthAnchor.split('-').map(Number);
        const d = new Date(y, m - 1 + delta, 1);
        setMonthAnchor(toDateStr(d).slice(0, 8) + '01');
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
            const [a, b] = await Promise.all([
                ensureMaterializedForToday('FOH', staffName),
                ensureMaterializedForToday('BOH', staffName),
            ]);
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
                    <div className="grid grid-cols-7 gap-1 text-center text-[10px] font-bold uppercase text-dd-text-2 mb-1">
                        {(isEs ? WD_ES : WD_EN).map(d => <div key={d}>{d}</div>)}
                    </div>
                    <div className="grid grid-cols-7 gap-1">
                        {cells.map((dateStr, i) => {
                            if (!dateStr) return <div key={`b${i}`} />;
                            const due = rulesDueOn(activeRules, dateStr);
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
                                        {due.slice(0, 3).map(r => (
                                            <div key={r.id}
                                                className={`text-[9px] leading-tight truncate rounded px-1 py-0.5 font-bold ${
                                                    r.side === 'BOH' ? 'bg-blue-100 text-blue-900' : 'bg-emerald-100 text-emerald-900'}`}>
                                                {r.task}
                                            </div>
                                        ))}
                                        {due.length > 3 && (
                                            <div className="text-[9px] text-dd-text-2 font-bold">+{due.length - 3}</div>
                                        )}
                                    </div>
                                </button>
                            );
                        })}
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-2 text-[10px] text-dd-text-2">
                        <span className="px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-900 font-bold">FOH</span>
                        <span className="px-1.5 py-0.5 rounded bg-blue-100 text-blue-900 font-bold">BOH</span>
                        <span>{tx('Tap a day to add or edit its tasks. Unchecked non-daily tasks carry over automatically.',
                            'Toca un día para agregar o editar. Las tareas no diarias sin marcar pasan al día siguiente solas.')}</span>
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
function DaySheet({ dateStr, rules, isEs, tx, staffName, staffList, onEdit, onClose }) {
    const due = rulesDueOn(rules, dateStr);
    const wd = weekdayOf(dateStr);
    const dayTitle = `${(isEs ? WD_ES : WD_EN)[wd]} ${Number(dateStr.slice(8))}/${Number(dateStr.slice(5, 7))}`;

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

    const add = async () => {
        const text = task.trim();
        if (!text || busy) return;
        const who = sideStaff.find(s => s.name === assignee);
        if (!who) { toast(tx('Pick who gets this task.', 'Elige quién recibe la tarea.'), { kind: 'error' }); return; }
        const recurrence =
            repeat === 'daily'  ? { type: 'daily', anchor: dateStr } :
            repeat === 'every2' ? { type: 'everyN', n: 2, anchor: dateStr } :
            repeat === 'everyN' ? { type: 'everyN', n: Math.max(2, Math.min(60, Number(everyN) || 3)), anchor: dateStr } :
            repeat === 'weekly' ? { type: 'weekly', weekdays: weekdays.length ? weekdays : [wd], anchor: dateStr } :
                                  { type: 'once', date: dateStr };
        setBusy(true);
        try {
            await createTaskPlanRule({
                task: text, side, assignTo: who, recurrence, createdBy: staffName,
            });
            setTask('');
            toast(tx('✓ Planned', '✓ Planificada'), { kind: 'success' });
        } catch (e) {
            toast(tx('Could not save: ', 'No se pudo guardar: ') + (e?.message || ''), { kind: 'error' });
        } finally { setBusy(false); }
    };

    return (
        <ModalPortal>
        <div className="fixed inset-0 z-[60] bg-black/50 flex items-end sm:items-center justify-center p-0 sm:p-3" onClick={onClose}>
            <div className="bg-white w-full sm:max-w-md max-h-[90vh] rounded-t-2xl sm:rounded-2xl flex flex-col overflow-hidden"
                onClick={(e) => e.stopPropagation()}>
                <div className="px-4 py-3 border-b border-dd-line flex items-center justify-between">
                    <h3 className="text-base font-black text-dd-text">🗓 {dayTitle}</h3>
                    <button onClick={onClose} className="w-8 h-8 rounded-full hover:bg-dd-bg flex items-center justify-center">✕</button>
                </div>
                <div className="flex-1 overflow-y-auto p-4 space-y-3">
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
                                            {recurrenceLabel(r, isEs)} · → {r.assignTo?.staffName || '?'}
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
                        <input type="text" value={task} onChange={e => setTask(e.target.value)}
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
                                <option value="">{tx('Who gets it…', 'Quién la recibe…')}</option>
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
        </ModalPortal>
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
                <input type="text" value={task} onChange={e => setTask(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-dd-line text-base" />
                <select value={assignee} onChange={e => setAssignee(e.target.value)}
                    className="w-full px-2 py-2 rounded-lg border border-dd-line bg-white text-sm">
                    {sideStaff.map(s => <option key={s.name} value={s.name}>{s.name}</option>)}
                </select>
                <button disabled={busy || !task.trim()}
                    onClick={() => run(() => {
                        const who = sideStaff.find(s => s.name === assignee) || rule.assignTo;
                        return updateTaskPlanRule(rule.id, {
                            task: task.trim(),
                            assignTo: { staffId: who?.staffId ?? who?.id ?? null, staffName: who?.staffName || who?.name },
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
