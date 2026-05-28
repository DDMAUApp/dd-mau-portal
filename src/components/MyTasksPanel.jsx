// MyTasksPanel — the "My Tasks" tab.
//
// 2026-05-27 (round 2) — Andrew: "i need that [the kanban] in the
// task page and use the current list as the master list." Promoted
// the kanban out of Operations → Assign Tasks (where it was buried)
// to the top-level My Tasks tab. Role split:
//
//   • Admins + managers           → AssignTasksPanel (kanban with
//                                   the existing task library on the
//                                   left + per-staff columns on the
//                                   right; add tasks, tap to assign,
//                                   mark done from any column).
//   • Staff + shift leads         → personal task list (their own
//                                   assignments only; mark done flow).
//
// The kanban + the personal list both read from the same
// /assigned_tasks collection, so a task assigned by a manager on the
// kanban appears on the assignee's personal list in real time.
//
// 2026-05-27 (round 1) — visual refresh: PageHeader + glass-card +
// Lucide icons + Apple-Reminders-style circular check buttons.
// Personal-list rendering below this header is unchanged from that
// pass.

import { useEffect, useMemo, useState, lazy, Suspense } from 'react';
import {
    subscribeAssignmentsForStaff,
    setAssignmentDone,
} from '../data/assignedTasks';
import { CheckSquare, PartyPopper, Check, ChevronDown, ChevronRight, Sparkles } from 'lucide-react';
import { PageHeader } from '../v2/PageShell';

// Lazy-load AssignTasksPanel so non-managers don't pay the bundle
// cost for code they'll never render.
const AssignTasksPanel = lazy(() => import('./AssignTasksPanel'));

const tx = (en, es, isEs) => (isEs ? es : en);

// Compact timestamp for the "Assigned by X · 3:14pm" line. Same-day
// shows time; other days show month/day.
function fmtWhen(ts) {
    if (!ts) return '';
    const d = ts.toDate ? ts.toDate() : new Date(ts);
    if (!d || isNaN(d.getTime())) return '';
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    if (sameDay) {
        return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    }
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export default function MyTasksPanel({
    language = 'en',
    staffName = '',
    staffList = [],
    isAdmin = false,
    isManager = false,
}) {
    const isEs = language === 'es';

    // Manager / admin viewers see the kanban — same component
    // that powers the Operations → Assign Tasks sub-tab. Master
    // list (the existing config/task_library_{side} doc) sits on
    // the left; per-staff columns on the right. Staff and shift
    // leads fall through to the personal-list render below.
    if (isAdmin || isManager) {
        return (
            <Suspense fallback={
                <div className="max-w-2xl mx-auto p-4">
                    <div className="glass-skeleton h-20 w-full rounded-glass-lg" />
                </div>
            }>
                <AssignTasksPanel
                    language={language}
                    staffName={staffName}
                    staffList={staffList}
                    isAdmin={isAdmin}
                />
            </Suspense>
        );
    }

    const me = useMemo(
        () => (staffList || []).find((s) => s.name === staffName) || null,
        [staffList, staffName]
    );

    const [assignments, setAssignments] = useState([]);
    const [loading, setLoading] = useState(true);
    useEffect(() => {
        if (me?.id == null) {
            setLoading(false);
            return undefined;
        }
        setLoading(true);
        const unsub = subscribeAssignmentsForStaff(me.id, (rows) => {
            setAssignments(rows);
            setLoading(false);
        });
        return unsub;
    }, [me?.id]);

    const open = useMemo(() => assignments.filter((a) => !a.done), [assignments]);
    const closed = useMemo(() => assignments.filter((a) => a.done), [assignments]);
    const [showClosed, setShowClosed] = useState(false);

    async function toggle(a) {
        try {
            await setAssignmentDone(a.id, { done: !a.done, staffName });
        } catch (err) {
            console.warn('toggle assignment failed:', err);
        }
    }

    if (!me) {
        return (
            <div className="max-w-2xl mx-auto p-4">
                <div className="glass-card p-8 text-center text-dd-text-2 text-sm">
                    {tx('Sign in to see your tasks.', 'Inicia sesión para ver tus tareas.', isEs)}
                </div>
            </div>
        );
    }

    // Subtitle for the page header — gives a quick at-a-glance status.
    const subtitle = loading
        ? tx('Loading…', 'Cargando…', isEs)
        : open.length === 0
            ? tx('All caught up — nothing open right now.', 'Todo al día — nada pendiente.', isEs)
            : tx(
                `${open.length} open · ${closed.length} completed`,
                `${open.length} pendiente${open.length === 1 ? '' : 's'} · ${closed.length} completada${closed.length === 1 ? '' : 's'}`,
                isEs,
            );

    return (
        <div className="space-y-4 max-w-2xl mx-auto p-4">
            <PageHeader
                icon={CheckSquare}
                title={tx('My Tasks', 'Mis Tareas', isEs)}
                subtitle={subtitle}
            />

            {loading ? (
                // Loading state — glass skeleton card so the layout
                // doesn't jump when assignments resolve.
                <div className="space-y-2">
                    <div className="glass-skeleton h-16 w-full rounded-glass-lg" />
                    <div className="glass-skeleton h-16 w-full rounded-glass-lg" />
                </div>
            ) : open.length === 0 && closed.length === 0 ? (
                // True empty state — never had any tasks (or everything
                // ever assigned has been cleared by an admin). Friendly
                // congratulatory copy + a confetti glyph.
                <div className="glass-card p-10 text-center">
                    <div className="w-14 h-14 mx-auto mb-3 rounded-full bg-dd-sage-50 text-dd-green-700 flex items-center justify-center">
                        <PartyPopper size={28} strokeWidth={2.25} aria-hidden="true" />
                    </div>
                    <p className="text-headline text-dd-text">
                        {tx("You're clear!", '¡Sin tareas!', isEs)}
                    </p>
                    <p className="text-footnote-md text-dd-text-2 mt-1">
                        {tx(
                            'No tasks assigned to you right now.',
                            'No tienes tareas asignadas ahora.',
                            isEs
                        )}
                    </p>
                </div>
            ) : (
                <>
                    {open.length === 0 ? (
                        // "All open done" state — there's history below
                        // but nothing pending. Lighter celebration tone.
                        <div className="glass-card p-6 text-center">
                            <div className="w-12 h-12 mx-auto mb-2 rounded-full bg-dd-sage-50 text-dd-green-700 flex items-center justify-center">
                                <Sparkles size={24} strokeWidth={2.25} aria-hidden="true" />
                            </div>
                            <p className="text-body-md font-bold text-dd-text">
                                {tx('All open tasks done. Nice.', 'Todas las tareas hechas. ¡Bien!', isEs)}
                            </p>
                        </div>
                    ) : (
                        <div className="space-y-2">
                            {open.map((a) => (
                                <div key={a.id} className="glass-card p-3">
                                    <div className="flex items-start gap-3">
                                        {/* Circular checkbox — Apple
                                            Reminders style. Empty outline
                                            ring at rest; fills with a
                                            green disc + Lucide Check on
                                            tap. The hit target is the
                                            full disc plus the surrounding
                                            tap area. */}
                                        <button onClick={() => toggle(a)}
                                            className="mt-0.5 w-6 h-6 rounded-full border-2 border-dd-line hover:border-dd-green hover:bg-dd-green/10 active:scale-90 transition-all duration-glass-fast ease-glass-out flex-shrink-0"
                                            aria-label={tx('Mark done', 'Marcar hecho', isEs)} />
                                        <div className="flex-1 min-w-0">
                                            <div className="text-body-md text-dd-text break-words">
                                                {a.task}
                                            </div>
                                            <div className="text-caption-md text-dd-text-2 mt-1">
                                                {tx('From', 'De', isEs)}{' '}
                                                <span className="font-semibold text-dd-text">{a.assignedBy || '—'}</span>
                                                {a.assignedAt && (
                                                    <span> · {fmtWhen(a.assignedAt)}</span>
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}

                    {closed.length > 0 && (
                        <div className="mt-4">
                            <button onClick={() => setShowClosed((v) => !v)}
                                className="inline-flex items-center gap-1.5 text-caption-md font-bold text-dd-text-2 hover:text-dd-green transition-colors">
                                {showClosed
                                    ? <ChevronDown size={14} strokeWidth={2.5} aria-hidden="true" />
                                    : <ChevronRight size={14} strokeWidth={2.5} aria-hidden="true" />}
                                {showClosed
                                    ? tx(
                                        `Hide ${closed.length} completed`,
                                        `Ocultar ${closed.length} completadas`,
                                        isEs
                                    )
                                    : tx(
                                        `Show ${closed.length} completed`,
                                        `Mostrar ${closed.length} completadas`,
                                        isEs
                                    )
                                }
                            </button>
                            {showClosed && (
                                <div className="space-y-1.5 mt-2">
                                    {closed.map((a) => (
                                        <div key={a.id}
                                            className="rounded-glass-md bg-white/40 border border-glass-border-light p-2.5 flex items-start gap-3 opacity-80 backdrop-blur-glass-subtle">
                                            <button onClick={() => toggle(a)}
                                                className="mt-0.5 w-5 h-5 rounded-full bg-dd-green text-white flex items-center justify-center flex-shrink-0 active:scale-90 transition-transform duration-glass-fast hover:bg-dd-green-700 ease-glass-out"
                                                title={tx('Reopen', 'Reabrir', isEs)}
                                                aria-label="Reopen">
                                                <Check size={12} strokeWidth={3} aria-hidden="true" />
                                            </button>
                                            <div className="flex-1 min-w-0">
                                                <div className="text-footnote-md line-through text-dd-text-2 break-words">
                                                    {a.task}
                                                </div>
                                                <div className="text-caption-md text-dd-text-2/80 mt-0.5">
                                                    {tx('Done', 'Hecho', isEs)}{' '}
                                                    {fmtWhen(a.doneAt)}
                                                </div>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}
                </>
            )}
        </div>
    );
}
