// MyTasksPanel — staff-facing "My Tasks" tab.
//
// Shows assignments addressed to the signed-in staffer:
//   • Open tasks at top (latest first), tap the checkbox to mark done.
//   • Completed tasks collapsed in a "Show N completed" section below.
//   • Empty state when there's nothing.
//
// Subscribes to /assigned_tasks/ where staffId == me.id. Real-time —
// new assignments from a manager appear without a refresh.

import { useEffect, useMemo, useState } from 'react';
import {
    subscribeAssignmentsForStaff,
    setAssignmentDone,
} from '../data/assignedTasks';

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
}) {
    const isEs = language === 'es';

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
            <div className="text-center text-dd-text-2 py-12 text-sm">
                {tx('Sign in to see your tasks.', 'Inicia sesión para ver tus tareas.', isEs)}
            </div>
        );
    }

    return (
        <div className="space-y-3 max-w-2xl mx-auto">
            <div className="flex items-center justify-between">
                <h1 className="text-xl font-bold text-dd-text flex items-center gap-2">
                    <span>✅</span>
                    <span>{tx('My Tasks', 'Mis Tareas', isEs)}</span>
                </h1>
                {!loading && (
                    <span className="text-sm text-dd-text-2">
                        {open.length === 0
                            ? tx('All done', 'Todo hecho', isEs)
                            : `${open.length} ${tx(open.length === 1 ? 'open' : 'open', open.length === 1 ? 'abierta' : 'abiertas', isEs)}`}
                    </span>
                )}
            </div>

            {loading ? (
                <div className="bg-white border border-dd-line rounded-xl p-6 text-center text-dd-text-2 shadow-card text-sm">
                    {tx('Loading…', 'Cargando…', isEs)}
                </div>
            ) : open.length === 0 && closed.length === 0 ? (
                <div className="bg-white border border-dd-line rounded-xl p-8 text-center shadow-card">
                    <div className="text-5xl mb-2">🎉</div>
                    <p className="text-dd-text font-bold">
                        {tx("You're clear!", '¡Sin tareas!', isEs)}
                    </p>
                    <p className="text-dd-text-2 text-sm mt-1">
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
                        <div className="bg-white border border-dd-line rounded-xl p-6 text-center text-dd-text-2 shadow-card">
                            <div className="text-3xl mb-1">✅</div>
                            {tx('All open tasks done. Nice.', 'Todas las tareas hechas. ¡Bien!', isEs)}
                        </div>
                    ) : (
                        <div className="space-y-2">
                            {open.map((a) => (
                                <div key={a.id}
                                    className="bg-white border border-dd-line rounded-xl p-3 shadow-card">
                                    <div className="flex items-start gap-3">
                                        <button onClick={() => toggle(a)}
                                            className="mt-0.5 w-6 h-6 rounded-md border-2 border-dd-line hover:border-dd-green hover:bg-dd-green/10 active:scale-95 transition flex-shrink-0"
                                            aria-label={tx('Mark done', 'Marcar hecho', isEs)} />
                                        <div className="flex-1 min-w-0">
                                            <div className="text-sm font-medium text-dd-text break-words">
                                                {a.task}
                                            </div>
                                            <div className="text-xs text-dd-text-2 mt-1">
                                                {tx('From', 'De', isEs)}{' '}
                                                <span className="font-medium">{a.assignedBy || '—'}</span>
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
                                className="text-xs font-bold text-dd-text-2 hover:text-dd-green transition">
                                {showClosed
                                    ? tx(
                                        `▼ Hide ${closed.length} completed`,
                                        `▼ Ocultar ${closed.length} completadas`,
                                        isEs
                                    )
                                    : tx(
                                        `▶ Show ${closed.length} completed`,
                                        `▶ Mostrar ${closed.length} completadas`,
                                        isEs
                                    )
                                }
                            </button>
                            {showClosed && (
                                <div className="space-y-1.5 mt-2">
                                    {closed.map((a) => (
                                        <div key={a.id}
                                            className="bg-dd-bg border border-dd-line rounded-lg p-2 flex items-start gap-2 opacity-75">
                                            <button onClick={() => toggle(a)}
                                                className="mt-0.5 w-5 h-5 rounded-md bg-dd-green text-white flex items-center justify-center text-xs flex-shrink-0 active:scale-95 transition"
                                                title={tx('Reopen', 'Reabrir', isEs)}
                                                aria-label="Reopen">
                                                ✓
                                            </button>
                                            <div className="flex-1 min-w-0">
                                                <div className="text-xs line-through text-dd-text-2 break-words">
                                                    {a.task}
                                                </div>
                                                <div className="text-[10px] text-dd-text-2 mt-0.5">
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
