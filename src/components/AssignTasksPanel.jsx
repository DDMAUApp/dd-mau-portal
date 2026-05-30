// AssignTasksPanel — manager view, lives inside Operations → "Assign Tasks"
// sub-tab.
//
// 2026-05-27 — Andrew kanban redesign:
//   "we have all the task list in one. when you assign it a staff its
//    still on the list. which i want to keep that will be the master
//    list. we add a task there and then when we assign to a staff it
//    goes to a column next to the master list with the staff name up
//    top and there assigned tasks. and a nother column if a different
//    task is assigned to a different person. we can also assign tasks
//    twice"
//
// Layout (per Andrew's spec):
//   Top:    PageHeader + admin-only FOH/BOH side switcher + search
//   Left:   Master task library — add new tasks here; tap any row to
//           open the staff picker and assign in one tap. Library rows
//           persist after assignment (and can be assigned to multiple
//           staff). Each row shows chips of who currently has it open.
//   Right:  Per-staff columns — one column per staff member with at
//           least one open assignment on this side. Each column is a
//           glass-card with the staff's name + count header and the
//           open tasks below (tap circular check to mark done, × to
//           unassign).
//
// Mobile (<lg): master list at top, per-staff sections stacked below.
// Desktop (lg+): master pinned left, per-staff columns scroll
// horizontally to the right.
//
// Data layer:
//   • subscribeTaskLibrary(side) — master list (unchanged)
//   • subscribeOpenAssignments(side) — NEW: all open assignments for
//     a side, grouped client-side by staffId for column rendering
//   • addLibraryEntry(side, task) — NEW: add to master list w/o
//     assignment
//   • assignTasksToStaff(...) — existing, one task per invocation
//     here (tap one library row, pick one staff, ship one assignment)
//   • setAssignmentDone / deleteAssignment — existing
//
// Side scoping:
//   • Admin gets FOH/BOH toggle and sees both lists / both staff pools.
//   • Non-admin manager is locked to their own scheduleSide.

import { useEffect, useMemo, useRef, useState } from 'react';
import {
    subscribeTaskLibrary,
    subscribeOpenAssignments,
    assignTasksToStaff,
    addLibraryEntry,
    searchLibrary,
    deleteLibraryEntry,
    renameLibraryEntry,
    deleteAssignment,
    setAssignmentDone,
    inferStaffSide,
} from '../data/assignedTasks';
import { ClipboardList, Search, Plus, Check, X, ChevronDown, Trash2, UserPlus, Pencil } from 'lucide-react';
import { PageHeader } from '../v2/PageShell';
import { isAdminId } from '../data/staff';

const tx = (en, es, isEs) => (isEs ? es : en);

// Compact timestamp for "Assigned X · 3:14pm" — same-day shows time
// only, otherwise month/day.
function fmtWhen(ts) {
    if (!ts) return '';
    const d = ts?.toDate ? ts.toDate() : new Date(ts);
    if (!d || isNaN(d.getTime())) return '';
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    if (sameDay) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

// Compute initials for a staff column header (matches the avatar disc
// pattern used in Header.jsx / Sidebar.jsx).
function initialsOf(name) {
    return (name || '?')
        .split(' ')
        .map((w) => w[0])
        .join('')
        .slice(0, 2)
        .toUpperCase();
}

// Predicate matching the same "is this staff record a manager?" rule
// used elsewhere in the app (App.jsx isManager check): admin id or
// role text containing "manager". Used to filter the kanban to
// manager-only columns when `managersOnly` is passed.
//
// When `includeShiftLeads` is true, also accepts staff with either
// the `shiftLead: true` boolean OR a role string containing "shift
// lead". Andrew 2026-05-28: assignees in the Tasks-tab kanban "can
// only be managers or shift leads."
function isManagerLike(record, { includeShiftLeads = false } = {}) {
    if (!record) return false;
    if (isAdminId(record.id)) return true;
    const roleText = String(record.role || '');
    if (/manager/i.test(roleText)) return true;
    if (includeShiftLeads) {
        if (record.shiftLead === true) return true;
        if (/shift\s*lead/i.test(roleText)) return true;
    }
    return false;
}

export default function AssignTasksPanel({
    language = 'en',
    staffName = '',
    staffList = [],
    isAdmin = false,
    isManager = false,
    isShiftLead = false,
    // When true, restricts the kanban to manager-class staff only:
    // staff-picker, columns, and "assigned-to" chips all filter to
    // managers. Master list is unchanged (shared library per side).
    // Used inside the Tasks sub-tab in Operations. Andrew 2026-05-28:
    // "when i assign a task in the task page to a staff which can
    // only be managers or shift leads."
    managersOnly = false,
    // When `managersOnly` is on, also include shift leads in the
    // pool (staff.shiftLead === true OR role text "shift lead"). Has
    // no effect if managersOnly is off.
    includeShiftLeads = false,
}) {
    const isEs = language === 'es';
    // canModify gates the edit-state controls (+ Add new task, delete a
    // master row, open the assign picker, X-unassign a column row).
    // Mirrors the Operations page's access list: admin + managers +
    // shift leads. Everyone else (regular staff) gets a read-only view
    // of the same kanban — they can still tap the circular check to
    // mark their own tasks done, but they can't reshape the board.
    const canModify = isAdmin || isManager || isShiftLead;

    // ── Manager identity + side scoping ─────────────────────────────
    const managerRecord = useMemo(
        () => (staffList || []).find((s) => s.name === staffName) || null,
        [staffList, staffName]
    );
    const myInferredSide = inferStaffSide(managerRecord) || 'FOH';
    const [side, setSide] = useState(myInferredSide);
    useEffect(() => {
        if (!isAdmin) setSide(myInferredSide);
    }, [isAdmin, myInferredSide]);

    // Staff on the current side. INCLUDES the manager themselves —
    // Andrew (admin) explicitly wanted to assign tasks to himself
    // and see his own column on the kanban. Excluding self meant
    // his column never appeared and the kanban felt empty for the
    // owner who's most likely to use it. (2026-05-27 round 3.)
    //
    // managersOnly: when true, filter the pool down to manager-class
    // staff (admins + anyone with /manager/ in their role). Per-staff
    // columns + the assign picker both narrow to this pool, so the
    // Operations "Mgr Tasks" view shows ONLY manager workloads
    // without changing the underlying assigned_tasks data model.
    const sideStaff = useMemo(() => {
        const list = Array.isArray(staffList) ? staffList : [];
        return list
            .filter((s) => s && s.name && s.active !== false)
            // scheduleSide === 'both' is a real value some managers
            // have ('both' meaning they cover both sides). inferStaffSide
            // returns null/FOH for those depending on role, which dropped
            // them from the picker AND from the column lookup, so the
            // assignment wrote successfully but the column never
            // appeared. Andrew 2026-05-28: "in the current task list
            // there is no movement when its assigned to a staff member."
            .filter((s) => {
                const explicit = String(s.scheduleSide || '').toLowerCase();
                if (explicit === 'both') return true;
                return inferStaffSide(s) === side;
            })
            .filter((s) => !managersOnly || isManagerLike(s, { includeShiftLeads }))
            .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    }, [staffList, side, managersOnly, includeShiftLeads]);

    // ── Master library subscription ─────────────────────────────────
    const [libItems, setLibItems] = useState([]);
    useEffect(() => subscribeTaskLibrary(side, setLibItems), [side]);

    // ── Open assignments subscription (kanban data source) ──────────
    const [openAssignments, setOpenAssignments] = useState([]);
    useEffect(() => subscribeOpenAssignments(side, setOpenAssignments), [side]);

    // Group open assignments by staffId — drives the per-staff columns.
    const assignmentsByStaff = useMemo(() => {
        const map = new Map();
        for (const a of openAssignments) {
            if (a.staffId == null) continue;
            if (!map.has(a.staffId)) map.set(a.staffId, []);
            map.get(a.staffId).push(a);
        }
        return map;
    }, [openAssignments]);

    // Map task text (lowercase) → array of staff names currently assigned.
    // Used to render "assigned to X, Y" chips next to each master row.
    const assignmentsByTask = useMemo(() => {
        const map = new Map();
        for (const a of openAssignments) {
            const key = (a.task || '').toLowerCase();
            if (!key) continue;
            if (!map.has(key)) map.set(key, []);
            map.get(key).push(a);
        }
        return map;
    }, [openAssignments]);

    // Staff columns to render = staff with at least one open assignment.
    //
    // ID match coerces both sides to string — staffList records may
    // have numeric ids (40, 41, ...) while Firestore round-trip can
    // return them as strings depending on the writer. Strict equality
    // failed when the types diverged, which caused new assignments to
    // be silently dropped from the column render — Andrew 2026-05-28
    // "no movement when its assigned to a staff member."
    //
    // Fallback: if the staff record can't be found in sideStaff (the
    // staff may be inactive, on a different side, or simply missing
    // from the loaded staffList because of race conditions), we still
    // render the column using the assignment's own `staffName`. The
    // column appearing matters more than the avatar disc being styled
    // from the staff record. Andrew 2026-05-28 round 2: "look at
    // safari its still not changed you can see the master list but
    // not he split off list."
    const staffColumns = useMemo(() => {
        const ids = Array.from(assignmentsByStaff.keys());
        const enriched = ids
            .map((id) => {
                const items = assignmentsByStaff.get(id) || [];
                if (items.length === 0) return null;
                const idStr = String(id);
                const member = sideStaff.find((s) => String(s.id) === idStr);
                if (member) {
                    return { staff: member, items };
                }
                // Fallback to assignment's own staffName so the
                // column still renders. Pull from the first item
                // (all items in this bucket share the same staffId
                // by construction of assignmentsByStaff).
                const fallbackName = items[0].staffName || 'Unknown';
                return {
                    staff: { id, name: fallbackName },
                    items,
                };
            })
            .filter(Boolean)
            // 2026-05-30 — Andrew: "i want staff to see their own task
            // list as the main list but to the side i want them to see
            // the whole list. that list they cant click. they check off
            // items only from their own list."
            //
            // Put the viewer's own column FIRST so it sits leftmost in
            // the horizontal scroller (acts as the prominent "my tasks"
            // pane). Other columns stay alphabetical to its right and
            // render with a view-only treatment for non-managers (the
            // mark-done button is hidden on those rows so a staffer
            // can't accidentally check off a coworker's task).
            .sort((a, b) => {
                const aMine = (a.staff.name || '') === staffName;
                const bMine = (b.staff.name || '') === staffName;
                if (aMine !== bMine) return aMine ? -1 : 1;
                return (a.staff.name || '').localeCompare(b.staff.name || '');
            });
        return enriched;
    }, [assignmentsByStaff, sideStaff, staffName]);

    // ── Master library — search + sort ──────────────────────────────
    const [librarySearch, setLibrarySearch] = useState('');
    const [librarySort, setLibrarySort] = useState('alpha'); // 'alpha' | 'most_used'
    const filteredLib = useMemo(
        () => searchLibrary(libItems, librarySearch, librarySort),
        [libItems, librarySearch, librarySort]
    );

    // ── + Add new task to master list ───────────────────────────────
    const [newTaskInput, setNewTaskInput] = useState('');
    const [adding, setAdding] = useState(false);
    async function handleAddToMaster(e) {
        e?.preventDefault?.();
        const t = newTaskInput.trim();
        if (!t || adding) return;
        setAdding(true);
        try {
            const { added } = await addLibraryEntry(side, t);
            if (!added) {
                toastFlash(tx('Already in the master list', 'Ya está en la lista maestra', isEs));
            }
            setNewTaskInput('');
        } catch (err) {
            console.warn('addLibraryEntry failed:', err);
            toastFlash(tx('Could not add — try again', 'No se pudo añadir — intenta otra vez', isEs));
        } finally {
            setAdding(false);
        }
    }

    // ── Assign workflow ─────────────────────────────────────────────
    // Tap a master row → opens a small staff-picker popover anchored
    // below the row. Pick a staff → instant single-task assignment.
    // Re-tapping the same task and picking the same staff just creates
    // another assignment (the user explicitly asked: "we can also
    // assign tasks twice").
    const [assignTarget, setAssignTarget] = useState(null); // { id, task, category }
    const pickerRef = useRef(null);
    // Inline edit state for a master library row. Andrew 2026-05-28:
    // "thats there we ad a edit the tasks." A pencil button on each
    // row swaps the title for an <input>; Enter / Save commits via
    // renameLibraryEntry, Esc / Cancel reverts. Only one row can be
    // edited at a time (state holds the row id).
    const [editingLibId, setEditingLibId] = useState(null);
    const [editingDraft, setEditingDraft] = useState('');
    const [savingEdit, setSavingEdit] = useState(false);
    function openEditLib(it) {
        setAssignTarget(null);
        setEditingLibId(it.id);
        setEditingDraft(it.task || '');
    }
    function cancelEditLib() {
        setEditingLibId(null);
        setEditingDraft('');
    }
    async function commitEditLib(it) {
        if (savingEdit) return;
        const next = (editingDraft || '').trim();
        if (!next) {
            cancelEditLib();
            return;
        }
        if (next === (it.task || '').trim()) {
            cancelEditLib();
            return;
        }
        setSavingEdit(true);
        try {
            const res = await renameLibraryEntry(side, it.id, next);
            if (!res?.renamed) {
                if (res?.reason === 'duplicate') {
                    toastFlash(tx('Already in the master list', 'Ya está en la lista maestra', isEs));
                } else {
                    toastFlash(tx('Could not save — try again', 'No se pudo guardar — intenta otra vez', isEs));
                }
                return;
            }
            cancelEditLib();
        } catch (err) {
            console.warn('renameLibraryEntry failed:', err);
            toastFlash(tx('Could not save — try again', 'No se pudo guardar — intenta otra vez', isEs));
        } finally {
            setSavingEdit(false);
        }
    }
    useEffect(() => {
        if (!assignTarget) return undefined;
        function onClickAway(e) {
            if (pickerRef.current && !pickerRef.current.contains(e.target)) {
                setAssignTarget(null);
            }
        }
        function onEsc(e) { if (e.key === 'Escape') setAssignTarget(null); }
        document.addEventListener('mousedown', onClickAway);
        document.addEventListener('keydown', onEsc);
        return () => {
            document.removeEventListener('mousedown', onClickAway);
            document.removeEventListener('keydown', onEsc);
        };
    }, [assignTarget]);

    // Ref + flag so we can auto-scroll the new column into view on
    // mobile after assignment. Without this Andrew on Safari kept
    // missing the column because it was rendering off-screen below
    // the master list. (2026-05-28 round 3.)
    const columnsRef = useRef(null);
    async function handleAssignTo(target, member) {
        try {
            await assignTasksToStaff({
                tasks: [{ task: target.task, category: target.category || 'other' }],
                staff: { id: member.id, name: member.name },
                manager: { id: managerRecord?.id ?? null, name: staffName },
                side,
            });
            toastFlash(tx(
                `Assigned to ${member.name}`,
                `Asignada a ${member.name}`,
                isEs
            ));
            setAssignTarget(null);
            // Scroll the new column into view horizontally (the
            // master + columns share a horizontal scroller). Best-
            // effort: bail quietly if the ref isn't attached yet.
            setTimeout(() => {
                try {
                    columnsRef.current?.scrollIntoView({
                        behavior: 'smooth',
                        inline: 'end',
                        block: 'nearest',
                    });
                } catch {}
            }, 120);
        } catch (err) {
            console.warn('assignTasksToStaff failed:', err);
            toastFlash(tx('Assign failed — try again', 'Error — intenta otra vez', isEs));
        }
    }

    // ── Per-assignment actions ──────────────────────────────────────
    async function handleMarkDone(a) {
        try { await setAssignmentDone(a.id, { done: true, staffName }); }
        catch (err) { console.warn('setAssignmentDone failed:', err); }
    }
    async function handleUnassign(a) {
        if (!window.confirm(tx(
            `Remove "${a.task}" from ${a.staffName}?`,
            `¿Quitar "${a.task}" de ${a.staffName}?`,
            isEs
        ))) return;
        try { await deleteAssignment(a.id); }
        catch (err) { console.warn('deleteAssignment failed:', err); }
    }

    // ── Toast ───────────────────────────────────────────────────────
    const [toast, setToast] = useState(null);
    const toastTimer = useRef(null);
    function toastFlash(msg) {
        setToast(msg);
        if (toastTimer.current) clearTimeout(toastTimer.current);
        toastTimer.current = setTimeout(() => setToast(null), 2400);
    }
    useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);

    // ── Render ──────────────────────────────────────────────────────
    return (
        <div className="space-y-4 max-w-[1600px] mx-auto p-4">
            <PageHeader
                icon={ClipboardList}
                title={managersOnly
                    ? tx('Manager Tasks', 'Tareas de Gerentes', isEs)
                    : tx('Assign Tasks', 'Asignar Tareas', isEs)}
                subtitle={managersOnly
                    ? tx(
                        `Master list on the left · split across ${staffColumns.length} manager${staffColumns.length === 1 ? '' : 's'}`,
                        `Lista maestra a la izquierda · dividida entre ${staffColumns.length} gerente${staffColumns.length === 1 ? '' : 's'}`,
                        isEs,
                    )
                    : tx(
                        `Master list on the left · ${staffColumns.length} staff with open tasks`,
                        `Lista maestra a la izquierda · ${staffColumns.length} miembros con tareas abiertas`,
                        isEs,
                    )}
                actions={isAdmin ? (
                    // Admin-only FOH/BOH toggle in the page header's
                    // actions slot. Non-admin managers are locked to
                    // their own side (no UI affordance needed).
                    <div className="inline-flex gap-1 glass-button-apple p-1">
                        {['FOH', 'BOH'].map((s) => (
                            <button key={s}
                                onClick={() => setSide(s)}
                                className={`px-3 py-1 rounded-md text-xs font-bold transition ${
                                    side === s
                                        ? 'bg-dd-green text-white shadow-sm'
                                        : 'text-dd-text-2 hover:text-dd-text'
                                }`}>
                                {s}
                            </button>
                        ))}
                    </div>
                ) : null}
            />

            {/* Trello-style horizontal kanban — master list on the
                LEFT, per-staff columns scroll horizontally to the
                right of it. Same on every viewport so the master and
                the columns are always side-by-side. Andrew 2026-05-28
                round 4: "its supposed to be next to it." */}
            <div className="flex gap-3 overflow-x-auto pb-2 -mx-3 px-3 scrollbar-thin">
                {/* ─── MASTER LIST (always leftmost column) ─── */}
                <div className="glass-card p-3 flex flex-col w-[85vw] sm:w-[320px] lg:w-[360px] shrink-0 min-h-[480px] max-h-[calc(100vh-200px)]">
                    <div className="flex items-center justify-between mb-3">
                        <div className="text-overline text-dd-text-2">
                            {tx('Master list', 'Lista maestra', isEs)}
                        </div>
                        <div className="inline-flex gap-0.5 bg-dd-bg/60 border border-dd-line rounded-glass-sm p-0.5">
                            <button onClick={() => setLibrarySort('alpha')}
                                className={`px-2 py-0.5 rounded-sm text-[10px] font-bold transition ${librarySort === 'alpha' ? 'bg-dd-green text-white' : 'text-dd-text-2'}`}>
                                A→Z
                            </button>
                            <button onClick={() => setLibrarySort('most_used')}
                                className={`px-2 py-0.5 rounded-sm text-[10px] font-bold transition ${librarySort === 'most_used' ? 'bg-dd-green text-white' : 'text-dd-text-2'}`}>
                                ★
                            </button>
                        </div>
                    </div>

                    {/* + Add new task — manager/admin only */}
                    {canModify && (
                        <form onSubmit={handleAddToMaster} className="flex gap-2 mb-2">
                            <input type="text"
                                value={newTaskInput}
                                onChange={(e) => setNewTaskInput(e.target.value)}
                                placeholder={tx('Add a new task…', 'Añadir una tarea…', isEs)}
                                className="glass-input flex-1" />
                            <button type="submit"
                                disabled={!newTaskInput.trim() || adding}
                                className="glass-button-primary inline-flex items-center justify-center w-10"
                                aria-label={tx('Add', 'Añadir', isEs)}>
                                <Plus size={16} strokeWidth={2.5} aria-hidden="true" />
                            </button>
                        </form>
                    )}

                    {/* Search bar */}
                    <div className="relative mb-2">
                        <Search size={14} strokeWidth={2.25} aria-hidden="true"
                            className="absolute left-3 top-1/2 -translate-y-1/2 text-dd-text-2" />
                        <input type="search"
                            value={librarySearch}
                            onChange={(e) => setLibrarySearch(e.target.value)}
                            placeholder={tx('Search…', 'Buscar…', isEs)}
                            className="glass-input pl-9" />
                    </div>

                    {/* Master list rows */}
                    <div className="flex-1 overflow-y-auto -mx-1 px-1 space-y-1">
                        {filteredLib.length === 0 ? (
                            <div className="text-footnote-md text-dd-text-2 text-center py-10 px-2">
                                {librarySearch
                                    ? tx('No matches.', 'Sin coincidencias.', isEs)
                                    : tx('Master list is empty. Type a task above to start.', 'Lista vacía. Escribe una tarea arriba.', isEs)}
                            </div>
                        ) : filteredLib.map((it) => {
                            const assignedStaff = assignmentsByTask.get((it.task || '').toLowerCase()) || [];
                            const isPicking = assignTarget?.id === it.id;
                            const isEditingThis = editingLibId === it.id;
                            return (
                                <div key={it.id} className="relative group/lib">
                                    {isEditingThis ? (
                                        // Inline editor — swaps in place of
                                        // the row button when admin clicks
                                        // ✏️. Enter saves, Esc cancels.
                                        <div className="w-full rounded-glass-md border bg-white border-dd-green/40 shadow-glass-sm px-2 py-1.5">
                                            <div className="flex items-center gap-1">
                                                <input
                                                    type="text"
                                                    autoFocus
                                                    value={editingDraft}
                                                    onChange={(e) => setEditingDraft(e.target.value)}
                                                    onKeyDown={(e) => {
                                                        if (e.key === 'Enter') { e.preventDefault(); commitEditLib(it); }
                                                        if (e.key === 'Escape') { e.preventDefault(); cancelEditLib(); }
                                                    }}
                                                    className="flex-1 min-w-0 text-body-md text-dd-text bg-transparent outline-none px-1 py-1"
                                                />
                                                <button
                                                    onClick={() => commitEditLib(it)}
                                                    disabled={savingEdit}
                                                    className="shrink-0 inline-flex items-center justify-center w-8 h-8 rounded-md bg-dd-green text-white disabled:opacity-60"
                                                    aria-label={tx('Save', 'Guardar', isEs)}>
                                                    <Check size={14} strokeWidth={2.5} aria-hidden="true" />
                                                </button>
                                                <button
                                                    onClick={cancelEditLib}
                                                    disabled={savingEdit}
                                                    className="shrink-0 inline-flex items-center justify-center w-8 h-8 rounded-md bg-dd-bg text-dd-text-2"
                                                    aria-label={tx('Cancel', 'Cancelar', isEs)}>
                                                    <X size={14} strokeWidth={2.5} aria-hidden="true" />
                                                </button>
                                            </div>
                                        </div>
                                    ) : (
                                    <button
                                        onClick={() => canModify && setAssignTarget(isPicking ? null : { id: it.id, task: it.task, category: it.category })}
                                        disabled={!canModify}
                                        className={`w-full text-left rounded-glass-md border px-3 py-2 transition-all duration-glass-fast ease-glass-out ${
                                            !canModify
                                                ? 'bg-white/40 border-glass-border-light cursor-default'
                                                : isPicking
                                                    ? 'bg-dd-sage-50 border-dd-green/40 shadow-glass-sm'
                                                    : 'bg-white/60 border-glass-border-light hover:bg-white hover:border-dd-green/20 hover:shadow-glass-sm'
                                        }`}>
                                        <div className="flex items-center gap-2">
                                            <span className="flex-1 text-body-md text-dd-text">{it.task}</span>
                                            {it.useCount > 1 && (
                                                <span className="text-caption-md font-bold text-dd-text-2 bg-dd-bg/80 px-1.5 py-0.5 rounded-sm shrink-0">
                                                    ×{it.useCount}
                                                </span>
                                            )}
                                            <UserPlus size={14} strokeWidth={2.25} aria-hidden="true"
                                                className={`shrink-0 transition-colors ${isPicking ? 'text-dd-green-700' : 'text-dd-text-2'}`} />
                                        </div>
                                        {assignedStaff.length > 0 && (
                                            <div className="flex flex-wrap gap-1 mt-1.5">
                                                {assignedStaff.map((a) => (
                                                    <span key={a.id}
                                                        className="inline-flex items-center gap-1 text-[10px] font-bold text-dd-green-700 bg-dd-sage-50 border border-dd-green/20 px-1.5 py-0.5 rounded-full">
                                                        <Check size={10} strokeWidth={3} aria-hidden="true" />
                                                        {a.staffName}
                                                    </span>
                                                ))}
                                            </div>
                                        )}
                                    </button>
                                    )}

                                    {/* Edit pencil — manager/admin only,
                                        appears on hover/focus so it doesn't
                                        clutter the row. Hidden while the
                                        assign picker is open OR this row
                                        is already in edit mode. Andrew
                                        2026-05-28 — "we ad a edit the
                                        tasks." */}
                                    {canModify && !isPicking && !isEditingThis && (
                                        <button
                                            onClick={(e) => { e.stopPropagation(); openEditLib(it); }}
                                            className={`absolute ${isAdmin ? 'right-9' : 'right-2'} top-1/2 -translate-y-1/2 w-6 h-6 rounded-full text-dd-text-2/60 hover:text-dd-green-700 hover:bg-dd-sage-50 flex items-center justify-center opacity-0 group-hover/lib:opacity-100 focus:opacity-100 transition-opacity`}
                                            style={{ pointerEvents: 'auto' }}
                                            title={tx('Edit task text', 'Editar texto', isEs)}
                                            aria-label={tx('Edit', 'Editar', isEs)}>
                                            <Pencil size={12} strokeWidth={2.25} aria-hidden="true" />
                                        </button>
                                    )}

                                    {/* Inline staff-picker popover */}
                                    {isPicking && (
                                        <div ref={pickerRef}
                                            className="absolute left-0 right-0 top-full mt-1 z-30 rounded-glass-md bg-white shadow-glass-floating border border-glass-border-light backdrop-blur-glass-medium p-2 max-h-[260px] overflow-y-auto">
                                            <div className="text-overline text-dd-text-2 mb-1.5 px-1">
                                                {tx('Assign to:', 'Asignar a:', isEs)}
                                            </div>
                                            {sideStaff.length === 0 ? (
                                                <div className="text-footnote-md text-dd-text-2 text-center py-3">
                                                    {tx(`No active ${side} staff.`, `Sin personal activo de ${side}.`, isEs)}
                                                </div>
                                            ) : sideStaff.map((member) => (
                                                <button key={member.id}
                                                    onClick={() => handleAssignTo({ id: it.id, task: it.task, category: it.category }, member)}
                                                    className="w-full flex items-center gap-2 px-2 py-1.5 rounded-glass-sm hover:bg-dd-sage-50 active:scale-[0.98] transition-all text-left">
                                                    <span className="glass-avatar-green w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0">
                                                        {initialsOf(member.name)}
                                                    </span>
                                                    <span className="flex-1 text-body-md text-dd-text">{member.name}</span>
                                                    {member.role && (
                                                        <span className="text-caption-md text-dd-text-2">{member.role}</span>
                                                    )}
                                                </button>
                                            ))}
                                        </div>
                                    )}

                                    {/* Admin trash icon — same row, overlaps the right edge */}
                                    {isAdmin && !isPicking && (
                                        <button
                                            onClick={async (e) => {
                                                e.stopPropagation();
                                                if (!window.confirm(tx(
                                                    `Delete "${it.task}" from master list?`,
                                                    `¿Eliminar "${it.task}" de la lista maestra?`,
                                                    isEs
                                                ))) return;
                                                try { await deleteLibraryEntry(side, it.id); }
                                                catch (err) { console.warn('deleteLibraryEntry failed:', err); }
                                            }}
                                            className="absolute right-2 top-1/2 -translate-y-1/2 w-6 h-6 rounded-full text-dd-text-2/60 hover:text-red-600 hover:bg-red-50 flex items-center justify-center opacity-0 hover:opacity-100 focus:opacity-100 transition-opacity"
                                            style={{ pointerEvents: 'auto' }}
                                            title={tx('Remove from master list', 'Eliminar de la lista', isEs)}
                                            aria-label="Delete">
                                            <Trash2 size={12} strokeWidth={2.25} aria-hidden="true" />
                                        </button>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </div>

                {/* ─── STAFF COLUMNS (sit immediately next to the
                       master list inside the same horizontal scroller
                       so the columns are always physically next to
                       master, not on a different row) ─── */}
                {staffColumns.length === 0 ? (
                    <div ref={columnsRef}
                        className="glass-card p-6 w-[85vw] sm:w-[320px] lg:w-[360px] shrink-0 flex flex-col items-center justify-center text-center">
                        <div className="w-12 h-12 mb-2 rounded-full bg-dd-sage-50 text-dd-green-700 flex items-center justify-center">
                            <UserPlus size={24} strokeWidth={2.25} aria-hidden="true" />
                        </div>
                        <p className="text-headline text-dd-text">
                            {managersOnly
                                ? tx('No manager tasks yet', 'Sin tareas de gerentes', isEs)
                                : tx('No open assignments yet', 'Sin tareas asignadas', isEs)}
                        </p>
                        <p className="text-footnote-md text-dd-text-2 mt-1">
                            {managersOnly
                                ? tx('Tap a task ← then pick a manager.', 'Toca una tarea ← y elige un gerente.', isEs)
                                : tx('Tap a task ← then pick a staff.', 'Toca una tarea ← y elige un miembro.', isEs)}
                        </p>
                    </div>
                ) : (
                    <div ref={columnsRef} className="flex gap-3 shrink-0">
                        {staffColumns.map(({ staff, items }) => {
                            // 2026-05-30 — per-column ownership + viewer
                            // capability. `isMine` is the only column the
                            // viewer can interact with when they aren't a
                            // manager (and even managers see the visual
                            // distinction). `readOnly` flips off the
                            // mark-done button on coworkers' columns for
                            // regular staff so they can't accidentally
                            // check off someone else's task.
                            const isMine   = (staff.name || '') === staffName;
                            const readOnly = !canModify && !isMine;
                            return (
                            <div key={staff.id}
                                className={`glass-card p-3 w-[80vw] sm:w-[280px] shrink-0 flex flex-col max-h-[calc(100vh-200px)] transition ${
                                    isMine
                                        ? 'ring-2 ring-dd-green/40 shadow-card-hov'
                                        : readOnly
                                            ? 'opacity-75'
                                            : ''
                                }`}>
                                {/* Column header — avatar + name + count + mine/view-only pill */}
                                <div className="flex items-center gap-2 mb-3 pb-2 border-b border-glass-border-light">
                                    <span className={`w-9 h-9 rounded-full flex items-center justify-center text-[12px] font-bold shrink-0 ${
                                        isMine ? 'bg-dd-green text-white' : 'glass-avatar-green'
                                    }`}>
                                        {initialsOf(staff.name)}
                                    </span>
                                    <div className="min-w-0 flex-1">
                                        <div className="flex items-center gap-1.5">
                                            <div className="text-headline text-dd-text truncate leading-tight">
                                                {isMine ? tx('My tasks', 'Mis tareas', isEs) : staff.name}
                                            </div>
                                            {isMine && (
                                                <span className="text-[9px] font-black uppercase tracking-wider bg-dd-green text-white px-1.5 py-0.5 rounded-full shrink-0">
                                                    {tx('Mine', 'Mío', isEs)}
                                                </span>
                                            )}
                                            {readOnly && (
                                                <span className="text-[9px] font-black uppercase tracking-wider bg-dd-bg text-dd-text-2 border border-dd-line px-1.5 py-0.5 rounded-full shrink-0">
                                                    {tx('View only', 'Solo ver', isEs)}
                                                </span>
                                            )}
                                        </div>
                                        <div className="text-caption-md text-dd-text-2">
                                            {!isMine && (
                                                <span className="font-semibold text-dd-text">{staff.name} · </span>
                                            )}
                                            {items.length} {tx(
                                                items.length === 1 ? 'open task' : 'open tasks',
                                                items.length === 1 ? 'tarea abierta' : 'tareas abiertas',
                                                isEs
                                            )}
                                        </div>
                                    </div>
                                </div>

                                {/* Task list */}
                                <div className="space-y-1.5 overflow-y-auto">
                                    {items.map((a) => (
                                        <div key={a.id}
                                            className={`group flex items-start gap-2 px-2.5 py-2 rounded-glass-md bg-white/60 border border-glass-border-light transition-colors ${
                                                readOnly ? '' : 'hover:bg-white'
                                            }`}>
                                            {!readOnly && (
                                                <button onClick={() => handleMarkDone(a)}
                                                    className="mt-0.5 w-5 h-5 rounded-full border-2 border-dd-line hover:border-dd-green hover:bg-dd-green/10 active:scale-90 transition-all flex items-center justify-center shrink-0"
                                                    aria-label={tx('Mark done', 'Marcar hecho', isEs)} />
                                            )}
                                            {readOnly && (
                                                <span className="mt-0.5 w-5 h-5 rounded-full border-2 border-dd-line/40 shrink-0"
                                                    title={tx('Only the owner can check this off', 'Solo el dueño puede marcarlo', isEs)} />
                                            )}
                                            <div className="flex-1 min-w-0">
                                                <div className="text-body-md text-dd-text break-words">
                                                    {a.task}
                                                </div>
                                                <div className="text-caption-md text-dd-text-2 mt-0.5">
                                                    {a.assignedBy && (
                                                        <span>{tx('From', 'De', isEs)} <span className="font-semibold text-dd-text">{a.assignedBy}</span></span>
                                                    )}
                                                    {a.assignedAt && (
                                                        <span> · {fmtWhen(a.assignedAt)}</span>
                                                    )}
                                                </div>
                                            </div>
                                            {canModify && (
                                                <button onClick={() => handleUnassign(a)}
                                                    className="w-6 h-6 rounded-full text-dd-text-2/60 hover:text-red-600 hover:bg-red-50 flex items-center justify-center opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity shrink-0"
                                                    aria-label={tx('Remove', 'Quitar', isEs)}>
                                                    <X size={14} strokeWidth={2.5} aria-hidden="true" />
                                                </button>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            </div>
                            );
                        })}
                    </div>
                )}
            </div>

            {/* Toast pinned to the bottom-center */}
            {toast && (
                <div className="fixed bottom-20 md:bottom-6 left-1/2 -translate-x-1/2 glass-card px-4 py-2 text-body-md font-bold shadow-glass-floating z-50 max-w-[92vw] text-center">
                    {toast}
                </div>
            )}
        </div>
    );
}
