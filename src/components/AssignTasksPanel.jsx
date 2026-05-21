// AssignTasksPanel — manager view, lives inside Operations → "Assign Tasks"
// sub-tab. Picks a staff member, drafts a list of tasks for them, ships
// the assignment to /assigned_tasks/ + bumps the side's task library.
//
// Layout (per Andrew's spec):
//   Top:   staff dropdown + admin-only FOH/BOH side switcher
//   Left:  draft assignment list with an inline new-task input
//   Right: task library — alphabetical (default) or most-used, searchable
//
// Side scoping:
//   • Admin gets a FOH/BOH toggle and sees both lists / both staff pools.
//   • Non-admin manager is locked to their own scheduleSide (or role-
//     inferred side). They never see the other side's staff or library.
//
// "AI-powered" search is fuzzy substring + token-match ranking (see
// searchLibrary in src/data/assignedTasks.js). No external API calls;
// instant feedback as the user types.

import { useEffect, useMemo, useState } from 'react';
import {
    subscribeTaskLibrary,
    assignTasksToStaff,
    searchLibrary,
    deleteLibraryEntry,
    inferStaffSide,
} from '../data/assignedTasks';

// Tiny i18n helper local to this file (project convention: every
// user-facing string is bilingual; we use the ternary form here so we
// don't pull in a heavier translation module for a leaf component).
const tx = (en, es, isEs) => (isEs ? es : en);

export default function AssignTasksPanel({
    language = 'en',
    staffName = '',
    staffList = [],
    isAdmin = false,
}) {
    const isEs = language === 'es';

    // Manager (the assigner) — used for the assignedBy attribution.
    const managerRecord = useMemo(
        () => (staffList || []).find((s) => s.name === staffName) || null,
        [staffList, staffName]
    );

    // Side: admin can toggle; everyone else is locked.
    const myInferredSide = inferStaffSide(managerRecord) || 'FOH';
    const [side, setSide] = useState(myInferredSide);
    // If the inferred side changes after first render (e.g. staffList
    // loaded async), re-sync for non-admins so we don't render a stale
    // side. Admins keep whatever they picked.
    useEffect(() => {
        if (!isAdmin) setSide(myInferredSide);
    }, [isAdmin, myInferredSide]);

    // Staff filtered to the current side. Exclude inactive AND the
    // manager (you can technically assign tasks to yourself, but in
    // practice it adds noise — drop yourself from the picker).
    const sideStaff = useMemo(() => {
        const list = Array.isArray(staffList) ? staffList : [];
        return list
            .filter((s) => s && s.name && s.active !== false)
            .filter((s) => s.name !== staffName)
            .filter((s) => inferStaffSide(s) === side)
            .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    }, [staffList, side, staffName]);

    const [selectedStaffId, setSelectedStaffId] = useState(null);
    const selectedStaff = useMemo(
        () => sideStaff.find((s) => s.id === Number(selectedStaffId) || s.id === selectedStaffId) || null,
        [sideStaff, selectedStaffId]
    );

    // Clear the selected staff if they fall out of the current side
    // (e.g. admin toggles FOH→BOH).
    useEffect(() => {
        if (selectedStaffId && !sideStaff.some((s) => s.id === selectedStaff?.id)) {
            setSelectedStaffId(null);
        }
    }, [sideStaff, selectedStaffId, selectedStaff]);

    // Draft assignment in progress.
    const [draftTasks, setDraftTasks] = useState([]); // [{key, task, category, fromLibId?}]
    const [newTaskInput, setNewTaskInput] = useState('');

    // Library subscription.
    const [libItems, setLibItems] = useState([]);
    useEffect(() => subscribeTaskLibrary(side, setLibItems), [side]);

    const [librarySearch, setLibrarySearch] = useState('');
    const [librarySort, setLibrarySort] = useState('alpha'); // 'alpha' | 'most_used'

    const filteredLib = useMemo(
        () => searchLibrary(libItems, librarySearch, librarySort),
        [libItems, librarySearch, librarySort]
    );

    // Track which library rows / texts are already in the draft so we
    // can grey them out and prevent doubles.
    const draftLibIds = useMemo(
        () => new Set(draftTasks.map((d) => d.fromLibId).filter(Boolean)),
        [draftTasks]
    );
    const draftTextLower = useMemo(
        () => new Set(draftTasks.map((d) => d.task.toLowerCase())),
        [draftTasks]
    );

    function addDraftTaskFromText(rawText, fromLibId = null, category = 'other') {
        const t = (rawText || '').trim();
        if (!t) return;
        if (draftTextLower.has(t.toLowerCase())) return;
        setDraftTasks((prev) => [...prev, {
            key: `d_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            task: t,
            category: category || 'other',
            fromLibId,
        }]);
    }

    function removeDraftTask(key) {
        setDraftTasks((prev) => prev.filter((d) => d.key !== key));
    }

    function handleSubmitNewTask(e) {
        e?.preventDefault?.();
        addDraftTaskFromText(newTaskInput);
        setNewTaskInput('');
    }

    const [submitting, setSubmitting] = useState(false);
    const [toast, setToast] = useState(null);

    async function handleAssign() {
        if (!selectedStaff || draftTasks.length === 0 || submitting) return;
        setSubmitting(true);
        try {
            const { writes } = await assignTasksToStaff({
                tasks: draftTasks.map((d) => ({ task: d.task, category: d.category })),
                staff: { id: selectedStaff.id, name: selectedStaff.name },
                manager: { id: managerRecord?.id ?? null, name: staffName },
                side,
            });
            setToast(tx(
                `Assigned ${writes} task${writes === 1 ? '' : 's'} to ${selectedStaff.name}`,
                `Asignada${writes === 1 ? '' : 's'} ${writes} tarea${writes === 1 ? '' : 's'} a ${selectedStaff.name}`,
                isEs
            ));
            setDraftTasks([]);
            setTimeout(() => setToast(null), 3000);
        } catch (err) {
            console.warn('assignTasksToStaff failed:', err);
            setToast(tx('Save failed — try again', 'Error al guardar — intenta otra vez', isEs));
            setTimeout(() => setToast(null), 4000);
        } finally {
            setSubmitting(false);
        }
    }

    // ── RENDER ─────────────────────────────────────────────────────────

    return (
        <div className="space-y-3">
            {/* Header — staff picker + admin-only side toggle */}
            <div className="bg-white border border-dd-line rounded-xl p-3 shadow-card">
                <div className="flex flex-wrap items-end gap-3">
                    {isAdmin && (
                        <div className="flex flex-col">
                            <span className="text-[10px] font-bold text-dd-text-2 uppercase tracking-wide mb-1">
                                {tx('Side', 'Lado', isEs)}
                            </span>
                            <div className="flex gap-1 bg-dd-bg border border-dd-line rounded-lg p-1">
                                {['FOH', 'BOH'].map((s) => (
                                    <button key={s}
                                        onClick={() => { setSide(s); setSelectedStaffId(null); setDraftTasks([]); }}
                                        className={`px-3 py-1.5 rounded-md text-xs font-bold transition ${
                                            side === s ? 'bg-dd-green text-white shadow-sm' : 'text-dd-text-2 hover:text-dd-text'
                                        }`}>
                                        {s}
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}
                    <label className="flex-1 min-w-[200px]">
                        <span className="block text-[10px] font-bold text-dd-text-2 uppercase tracking-wide mb-1">
                            {tx(`Assign to (${side})`, `Asignar a (${side})`, isEs)}
                        </span>
                        <select
                            value={selectedStaffId == null ? '' : String(selectedStaffId)}
                            onChange={(e) => setSelectedStaffId(e.target.value || null)}
                            className="w-full border border-dd-line rounded-lg px-3 py-2 text-sm bg-white">
                            <option value="">{tx('— Pick a staff member —', '— Elige un miembro —', isEs)}</option>
                            {sideStaff.map((s) => (
                                <option key={s.id} value={String(s.id)}>
                                    {s.name}{s.role ? ` (${s.role})` : ''}
                                </option>
                            ))}
                        </select>
                    </label>
                </div>
                {sideStaff.length === 0 && (
                    <p className="text-xs text-dd-text-2 mt-2">
                        {tx(
                            `No active ${side} staff. Add staff in Admin Panel.`,
                            `No hay personal activo de ${side}. Añade personal en el Panel de Admin.`,
                            isEs
                        )}
                    </p>
                )}
            </div>

            {!selectedStaff ? (
                <div className="bg-white border border-dd-line rounded-xl p-6 text-center text-dd-text-2 text-sm shadow-card">
                    {tx(
                        `Pick a ${side} staff member above to start assigning tasks.`,
                        `Elige un miembro de ${side} arriba para empezar a asignar tareas.`,
                        isEs
                    )}
                </div>
            ) : (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                    {/* ─── LEFT: draft assignment ─── */}
                    <div className="bg-white border border-dd-line rounded-xl p-3 shadow-card flex flex-col min-h-[420px]">
                        <div className="flex items-center justify-between mb-2">
                            <div className="font-bold text-dd-text text-sm">
                                {tx('New tasks for', 'Nuevas tareas para', isEs)}{' '}
                                <span className="text-dd-green">{selectedStaff.name}</span>
                            </div>
                            <span className="text-xs text-dd-text-2">
                                {draftTasks.length} {tx(
                                    draftTasks.length === 1 ? 'task' : 'tasks',
                                    draftTasks.length === 1 ? 'tarea' : 'tareas',
                                    isEs
                                )}
                            </span>
                        </div>

                        <form onSubmit={handleSubmitNewTask} className="flex gap-2 mb-2">
                            <input
                                type="text"
                                value={newTaskInput}
                                onChange={(e) => setNewTaskInput(e.target.value)}
                                placeholder={tx('Type a task and hit Enter…', 'Escribe una tarea y presiona Enter…', isEs)}
                                className="flex-1 border border-dd-line rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-dd-green/30"
                            />
                            <button type="submit"
                                disabled={!newTaskInput.trim()}
                                className="bg-dd-green text-white px-3 py-2 rounded-lg text-sm font-bold disabled:opacity-40 active:scale-95 transition">
                                {tx('Add', 'Añadir', isEs)}
                            </button>
                        </form>

                        <div className="flex-1 overflow-y-auto space-y-2 mb-2 pr-1">
                            {draftTasks.length === 0 ? (
                                <div className="text-xs text-dd-text-2 text-center py-12 px-2">
                                    {tx(
                                        'Click items from the library on the right, or type new ones above.',
                                        'Haz clic en elementos de la biblioteca a la derecha, o escribe nuevas tareas arriba.',
                                        isEs
                                    )}
                                </div>
                            ) : draftTasks.map((d, idx) => (
                                <div key={d.key}
                                    className="flex items-center gap-2 bg-dd-bg border border-dd-line rounded-lg px-3 py-2">
                                    <span className="text-xs font-bold text-dd-text-2 w-5 flex-shrink-0">{idx + 1}.</span>
                                    <span className="flex-1 text-sm">{d.task}</span>
                                    <button onClick={() => removeDraftTask(d.key)}
                                        className="text-dd-text-2 hover:text-red-500 text-lg leading-none px-1 flex-shrink-0"
                                        aria-label="Remove">×</button>
                                </div>
                            ))}
                        </div>

                        <button onClick={handleAssign}
                            disabled={draftTasks.length === 0 || submitting}
                            className="w-full bg-dd-green text-white py-2.5 rounded-lg font-bold text-sm disabled:opacity-40 active:scale-95 transition">
                            {submitting
                                ? tx('Saving…', 'Guardando…', isEs)
                                : draftTasks.length === 0
                                    ? tx('Add tasks to assign', 'Añade tareas para asignar', isEs)
                                    : tx(
                                        `Assign ${draftTasks.length} task${draftTasks.length === 1 ? '' : 's'} to ${selectedStaff.name}`,
                                        `Asignar ${draftTasks.length} tarea${draftTasks.length === 1 ? '' : 's'} a ${selectedStaff.name}`,
                                        isEs
                                    )
                            }
                        </button>
                    </div>

                    {/* ─── RIGHT: library ─── */}
                    <div className="bg-white border border-dd-line rounded-xl p-3 shadow-card flex flex-col min-h-[420px]">
                        <div className="flex items-center justify-between mb-2 gap-2">
                            <div className="font-bold text-dd-text text-sm">
                                {tx('Task library', 'Biblioteca', isEs)}{' '}
                                <span className="text-xs font-normal text-dd-text-2">({side})</span>
                            </div>
                            <div className="flex gap-0.5 bg-dd-bg border border-dd-line rounded-lg p-0.5">
                                <button onClick={() => setLibrarySort('alpha')}
                                    className={`px-2 py-1 rounded text-[10px] font-bold transition ${
                                        librarySort === 'alpha' ? 'bg-dd-green text-white' : 'text-dd-text-2'
                                    }`}>
                                    A→Z
                                </button>
                                <button onClick={() => setLibrarySort('most_used')}
                                    className={`px-2 py-1 rounded text-[10px] font-bold transition ${
                                        librarySort === 'most_used' ? 'bg-dd-green text-white' : 'text-dd-text-2'
                                    }`}>
                                    ⭐ {tx('Most', 'Más', isEs)}
                                </button>
                            </div>
                        </div>

                        <input
                            type="search"
                            value={librarySearch}
                            onChange={(e) => setLibrarySearch(e.target.value)}
                            placeholder={tx('Search past tasks…', 'Buscar tareas anteriores…', isEs)}
                            className="w-full border border-dd-line rounded-lg px-3 py-2 text-sm mb-2 focus:outline-none focus:ring-2 focus:ring-dd-green/30"
                        />

                        <div className="flex-1 overflow-y-auto space-y-1 pr-1">
                            {filteredLib.length === 0 ? (
                                <div className="text-xs text-dd-text-2 text-center py-12 px-2">
                                    {librarySearch
                                        ? tx('No matches. Type a new task on the left.', 'Sin coincidencias. Escribe una nueva tarea a la izquierda.', isEs)
                                        : tx('Library is empty. Tasks you assign appear here automatically.', 'La biblioteca está vacía. Las tareas que asignes aparecerán aquí.', isEs)
                                    }
                                </div>
                            ) : filteredLib.map((it) => {
                                const alreadyDraft = (it.id && draftLibIds.has(it.id))
                                    || draftTextLower.has((it.task || '').toLowerCase());
                                return (
                                    <div key={it.id} className="flex items-stretch gap-1">
                                        <button
                                            onClick={() => {
                                                if (alreadyDraft) return;
                                                addDraftTaskFromText(it.task, it.id, it.category);
                                            }}
                                            disabled={alreadyDraft}
                                            className={`flex-1 text-left px-3 py-2 rounded-lg border text-sm transition flex items-center gap-2 min-w-0 ${
                                                alreadyDraft
                                                    ? 'bg-dd-bg border-dd-line text-dd-text-2 opacity-60 cursor-default'
                                                    : 'bg-white border-dd-line hover:bg-dd-bg active:scale-[0.99]'
                                            }`}>
                                            <span className="flex-1 truncate">{it.task}</span>
                                            {it.useCount > 1 && (
                                                <span className="text-[10px] font-bold text-dd-text-2 bg-dd-bg px-1.5 py-0.5 rounded flex-shrink-0">
                                                    ×{it.useCount}
                                                </span>
                                            )}
                                            {alreadyDraft && (
                                                <span className="text-[10px] text-dd-green flex-shrink-0">✓</span>
                                            )}
                                        </button>
                                        {isAdmin && (
                                            <button
                                                onClick={async () => {
                                                    if (!window.confirm(tx(
                                                        `Delete "${it.task}" from library?`,
                                                        `¿Eliminar "${it.task}" de la biblioteca?`,
                                                        isEs
                                                    ))) return;
                                                    try { await deleteLibraryEntry(side, it.id); }
                                                    catch (err) { console.warn('deleteLibraryEntry failed:', err); }
                                                }}
                                                className="px-2 text-dd-text-2 hover:text-red-500 hover:bg-red-50 rounded-lg border border-transparent hover:border-red-200 flex-shrink-0 text-xs"
                                                title={tx('Remove from library (admin)', 'Eliminar de la biblioteca (admin)', isEs)}
                                                aria-label="Delete library entry">
                                                🗑
                                            </button>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                </div>
            )}

            {toast && (
                <div className="fixed bottom-20 md:bottom-6 left-1/2 -translate-x-1/2 bg-dd-charcoal text-white px-4 py-2 rounded-lg shadow-lg text-sm z-50 max-w-[90vw] text-center">
                    {toast}
                </div>
            )}
        </div>
    );
}
