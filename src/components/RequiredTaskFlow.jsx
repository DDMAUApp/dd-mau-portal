// Full-screen flow renderer for pending required tasks.
//
// Mounted by App.jsx after PIN unlock when the current staffer has
// blocking tasks in /required_tasks. The flow walks tasks in order
// of priority, one at a time. The user can't reach Chat / Schedule /
// any other tab until either:
//   1. Every blocking task is completed/skipped/declined, OR
//   2. They sign out (resets at next sign-in, tasks still pending)
//
// Each task type has its own React component lazy-loaded below.
// Adding a new type = drop a new component, add an entry in the
// COMPONENTS map, add the registry entry in src/data/requiredTasks.js.
//
// Design choices:
//   • One task at a time — less overwhelming than a wall of forms
//   • Progress dots at top — staff can see how many are left
//   • "Sign out" escape hatch in the corner — for emergencies
//     where the staffer truly can't complete (e.g. their phone died
//     and they need to come back later). Their tasks stay pending.
//   • No "back" button — once a task is completed it's done; we
//     don't let the staffer reopen and re-decide. If they need to
//     change their answer they edit it through the normal UI path
//     (AdminPanel or their profile).

import { useState, useEffect, lazy, Suspense } from 'react';
import { TASK_TYPES, completeTask, skipTask, fetchPendingTasksFor } from '../data/requiredTasks';

// Lazy-loaded per-type components. Each component receives:
//   { task, staff, language, onComplete(snapshot), onSkip() }
// and is responsible for rendering its own UI + calling back
// when the user has finished their interaction.
const TaskSmsOptIn = lazy(() => import('./RequiredTaskSmsOptIn'));
const TaskAvailability = lazy(() => import('./RequiredTaskAvailability'));

const COMPONENTS = {
    sms_optin: TaskSmsOptIn,
    availability: TaskAvailability,
};

export default function RequiredTaskFlow({
    staffName,
    staff,
    staffList,
    setStaffList,
    language,
    onAllDone,
    onSignOut,
}) {
    const [tasks, setTasks] = useState([]);
    const [activeIdx, setActiveIdx] = useState(0);
    const [loading, setLoading] = useState(true);

    // Initial fetch. We refetch after each completion to keep the
    // queue accurate — autoComplete or admin cancellations could
    // have removed tasks in the background.
    const reload = async () => {
        setLoading(true);
        const list = await fetchPendingTasksFor(staffName);
        // Only show blocking tasks in the flow. Soft tasks show
        // elsewhere as banners.
        const blocking = list.filter(t => t.blockApp === true);
        setTasks(blocking);
        setActiveIdx(0);
        setLoading(false);
        if (blocking.length === 0 && typeof onAllDone === 'function') {
            onAllDone();
        }
    };

    useEffect(() => {
        reload();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [staffName]);

    const handleComplete = async (snapshot) => {
        const task = tasks[activeIdx];
        if (!task) return;
        await completeTask(task.id, {
            snapshot,
            byName: staffName,
        });
        // Advance: drop the current task and re-evaluate the queue.
        // We refetch instead of just incrementing the index because
        // multiple tasks could share dependencies (e.g. opting in to
        // SMS also satisfies a follow-up "confirm phone" task).
        await reload();
    };

    const handleSkip = async () => {
        const task = tasks[activeIdx];
        if (!task || !task.allowSkip) return;
        await skipTask(task.id, { byName: staffName });
        await reload();
    };

    if (loading) {
        return (
            <div className="fixed inset-0 z-[60] bg-white flex items-center justify-center">
                <div className="text-dd-text-2 text-sm">
                    {language === 'es' ? 'Cargando…' : 'Loading…'}
                </div>
            </div>
        );
    }

    if (tasks.length === 0) {
        return null;
    }

    const task = tasks[activeIdx];
    const typeDef = TASK_TYPES[task.taskType];
    const Component = COMPONENTS[task.taskType];

    if (!typeDef || !Component) {
        // Unknown task type — likely a future type that this client
        // doesn't know about yet. Allow skipping (forced) so the
        // staffer isn't bricked. Admin can cancel it on their side.
        return (
            <div className="fixed inset-0 z-[60] bg-white flex flex-col">
                <div className="flex-1 flex items-center justify-center p-6 text-center">
                    <div>
                        <div className="text-4xl mb-3">⚠️</div>
                        <p className="text-sm font-bold text-dd-text mb-1">
                            {language === 'es' ? 'Tarea desconocida' : 'Unknown task'}
                        </p>
                        <p className="text-xs text-dd-text-2 mb-4">
                            {language === 'es'
                                ? 'Actualiza la app o pídele a tu gerente.'
                                : 'Refresh the app or ask your manager.'}
                        </p>
                        <button onClick={handleSkip}
                            className="px-4 py-2 rounded-lg bg-dd-text text-white text-sm font-bold">
                            {language === 'es' ? 'Saltar por ahora' : 'Skip for now'}
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    const langKey = (task.language || staff?.preferredLanguage || language) === 'es' ? 'es' : 'en';
    const isEs = langKey === 'es';

    return (
        <div className="fixed inset-0 z-[60] bg-dd-bg flex flex-col overflow-hidden">
            {/* Header — progress + escape */}
            <div className="bg-white border-b border-dd-line px-4 py-3 flex items-center justify-between safe-top">
                <div className="flex items-center gap-2 min-w-0">
                    <span className="text-2xl flex-shrink-0">{typeDef.icon}</span>
                    <div className="min-w-0">
                        <div className="text-[10px] font-bold uppercase tracking-wider text-dd-text-2">
                            {isEs ? 'Antes de continuar' : 'Before you continue'}
                        </div>
                        <div className="text-sm font-bold text-dd-text truncate">
                            {isEs ? typeDef.labelEs : typeDef.labelEn}
                        </div>
                    </div>
                </div>
                {/* Progress dots — visible only when more than 1 task in queue */}
                {tasks.length > 1 && (
                    <div className="flex items-center gap-1 flex-shrink-0">
                        {tasks.map((_, i) => (
                            <span key={i}
                                className={`h-1.5 rounded-full transition-all ${
                                    i === activeIdx ? 'bg-dd-green w-6' : 'bg-dd-line w-1.5'
                                }`} />
                        ))}
                    </div>
                )}
            </div>

            {/* Body — task-specific component */}
            <div className="flex-1 overflow-y-auto">
                <Suspense fallback={
                    <div className="flex items-center justify-center h-32 text-sm text-dd-text-2">
                        {isEs ? 'Cargando…' : 'Loading…'}
                    </div>
                }>
                    <Component
                        task={task}
                        staff={staff}
                        staffList={staffList}
                        setStaffList={setStaffList}
                        staffName={staffName}
                        language={langKey}
                        onComplete={handleComplete}
                        onSkip={task.allowSkip ? handleSkip : null}
                    />
                </Suspense>
            </div>

            {/* Footer — sign-out escape hatch */}
            <div className="border-t border-dd-line bg-white px-4 py-2 safe-bottom">
                <button onClick={onSignOut}
                    className="w-full text-[11px] text-dd-text-2 hover:text-dd-text underline">
                    {isEs
                        ? 'Cerrar sesión — completar después'
                        : 'Sign out — finish this later'}
                </button>
            </div>
        </div>
    );
}
