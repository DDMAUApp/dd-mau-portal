// AssigneePickerModal — bottom-sheet picker for assigning a checklist
// task to one or more staff members.
//
// Andrew 2026-05-24 — "make it easier to assign a staff to the tasks."
// Replaces the tiny native <select> buried inside the per-task edit
// form with a full-width sheet that has:
//   • multi-select checkboxes (pre-selected = currently assigned)
//   • avatar initials + role hint per row
//   • "Just me" quick pill at top
//   • search filter (fast for the >20-staff case)
//   • side filter applied by the caller (only FOH or only BOH)
//   • single Save = one write to Firestore (not per-name)
//
// The caller passes `eligibleStaff` (already side-filtered + location-
// filtered) and the current `assignedNames`. On save it returns the
// new full `assignTo` array via onSave(names) — the caller wires that
// into the existing customTasks write path. The component does NOT
// touch Firestore directly; keeps it reusable for non-checklist
// callers later (e.g. assigning a maintenance ticket, a coverage
// request candidate, etc.).

import { useEffect, useMemo, useState } from 'react';
import ModalPortal from './ModalPortal';

export default function AssigneePickerModal({
    open,
    onClose,
    onSave,
    taskTitle = '',
    eligibleStaff = [],   // [{ id, name, role, ... }] already filtered to the right side + location
    assignedNames = [],   // string[] — current assignees, used to pre-check
    currentStaffName,     // string  — the manager doing the assigning, drives "Just me"
    language = 'en',
}) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);

    // Local working set of names — mutated as user toggles. Initialized
    // from props on every open so a cancel leaves the original state.
    const [selected, setSelected] = useState(() => new Set(assignedNames));
    const [search, setSearch] = useState('');
    const [saving, setSaving] = useState(false);

    // Stable, content-based key for assignedNames. Callers pass a
    // freshly-allocated array on most renders — e.g. Operations builds
    // `Array.isArray(task.assignTo) ? task.assignTo : (task.assignTo ? [task.assignTo] : [])`,
    // so an unassigned task yields a brand-new `[]` and a legacy
    // single-string assignment a brand-new `[name]` EVERY render. If the
    // reset effect below depended on the array's IDENTITY, any parent
    // re-render (Operations has a 30s deadline interval + ~24 onSnapshot
    // listeners) would re-fire it mid-pick and wipe the manager's
    // in-progress selections. Keying on sorted CONTENT means the effect
    // only re-syncs when the actual set of names changes — never on a
    // no-op re-render. (assignedKey stays the same string across renders
    // even though useMemo recomputes it, so Object.is dep-compare skips.)
    const assignedKey = useMemo(
        () => Array.from(assignedNames || []).map(String).sort().join(''),
        [assignedNames]
    );

    // Reset state on each open AND whenever the committed assignee set
    // actually changes. Without this, opening picker A, picking names,
    // canceling, opening picker B for a different task would leave A's
    // selections pre-checked on B.
    useEffect(() => {
        if (open) {
            setSelected(new Set(assignedNames));
            setSearch('');
            setSaving(false);
        }
    // Depend on assignedKey (stable content), NOT assignedNames
    // (unstable identity) — see the note above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, assignedKey]);

    const toggleName = (name) => {
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(name)) next.delete(name);
            else next.add(name);
            return next;
        });
    };

    // Sorted + filtered staff. Currently-assigned names rise to the top
    // (since the manager probably wants to confirm or tweak them first),
    // then alphabetical for the rest.
    const visibleStaff = useMemo(() => {
        const q = search.trim().toLowerCase();
        const filtered = eligibleStaff
            .filter((s) => s && s.name)
            .filter((s) => !q
                || s.name.toLowerCase().includes(q)
                || (s.role || '').toLowerCase().includes(q));
        return filtered.sort((a, b) => {
            const aSel = selected.has(a.name) ? 0 : 1;
            const bSel = selected.has(b.name) ? 0 : 1;
            if (aSel !== bSel) return aSel - bSel;
            return (a.name || '').localeCompare(b.name || '');
        });
    }, [eligibleStaff, search, selected]);

    const handleSave = async () => {
        if (saving) return;
        setSaving(true);
        try {
            await onSave(Array.from(selected));
            onClose?.();
        } catch (e) {
            console.warn('AssigneePicker save failed:', e);
            // Caller's onSave usually toasts the user-facing error; we
            // just unblock the button so they can retry.
        } finally {
            setSaving(false);
        }
    };

    const handleClearAll = () => setSelected(new Set());

    const meAssigned = currentStaffName ? selected.has(currentStaffName) : false;
    const meEligible = currentStaffName && eligibleStaff.some((s) => s.name === currentStaffName);

    if (!open) return null;
    return (
        <ModalPortal>
        <div
            className="fixed inset-0 z-50 bg-black/50 flex items-end md:items-center justify-center"
            onClick={onClose}
        >
            <div
                className="bg-white w-full md:max-w-md md:rounded-2xl rounded-t-2xl flex flex-col max-h-[85vh] shadow-xl animate-slide-up"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <div className="px-4 pt-3 pb-2 border-b border-dd-line shrink-0">
                    {/* Mobile drag handle */}
                    <div className="md:hidden flex justify-center mb-2">
                        <div className="w-10 h-1 bg-dd-line rounded-full" />
                    </div>
                    <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                            <h2 className="text-base font-black text-dd-text">
                                👤 {tx('Assign task', 'Asignar tarea')}
                            </h2>
                            {taskTitle && (
                                <p className="text-[11.5px] text-dd-text-2 truncate mt-0.5">{taskTitle}</p>
                            )}
                        </div>
                        <button
                            onClick={onClose}
                            className="w-9 h-9 rounded-full hover:bg-dd-bg text-dd-text-2 flex items-center justify-center shrink-0"
                            aria-label={tx('Close', 'Cerrar')}
                        >
                            ✕
                        </button>
                    </div>
                </div>

                {/* Quick row — "Just me" pill + clear-all */}
                <div className="px-4 py-2 border-b border-dd-line/60 flex items-center gap-2 shrink-0 bg-dd-bg/40">
                    {meEligible && (
                        <button
                            type="button"
                            onClick={() => toggleName(currentStaffName)}
                            className={`px-3 py-1.5 rounded-full text-xs font-bold transition border ${meAssigned
                                ? 'bg-dd-green text-white border-dd-green'
                                : 'bg-white text-dd-green-700 border-dd-green/40 hover:bg-dd-sage-50'}`}
                        >
                            {meAssigned ? `✓ ${tx('Me', 'Yo')}` : `+ ${tx('Me', 'Yo')}`}
                        </button>
                    )}
                    <span className="flex-1" />
                    {selected.size > 0 && (
                        <button
                            type="button"
                            onClick={handleClearAll}
                            className="text-[11px] font-bold text-dd-text-2 hover:text-red-600 hover:underline"
                        >
                            {tx('Clear all', 'Limpiar')}
                        </button>
                    )}
                </div>

                {/* Search */}
                <div className="px-4 py-2 border-b border-dd-line/60 shrink-0">
                    <input
                        type="search"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder={tx('Search staff…', 'Buscar personal…')}
                        autoFocus={false /* iOS would zoom; staff list is short */}
                        className="w-full px-3 py-2 rounded-lg bg-dd-bg border border-dd-line text-base focus:outline-none focus:ring-2 focus:ring-dd-green/30 focus:border-dd-green"
                    />
                </div>

                {/* Staff list */}
                <div className="flex-1 overflow-y-auto">
                    {visibleStaff.length === 0 ? (
                        <div className="p-8 text-center text-sm text-dd-text-2">
                            {tx('No matching staff.', 'Sin coincidencias.')}
                        </div>
                    ) : (
                        visibleStaff.map((staff) => {
                            const isMe = staff.name === currentStaffName;
                            const isSelected = selected.has(staff.name);
                            const initials = (staff.name.split(' ').map((p) => p[0]).slice(0, 2).join('') || '?').toUpperCase();
                            return (
                                <label
                                    key={staff.id ?? staff.name}
                                    className="flex items-center gap-3 px-4 py-2.5 border-b border-dd-line/40 hover:bg-dd-bg cursor-pointer"
                                >
                                    <input
                                        type="checkbox"
                                        checked={isSelected}
                                        onChange={() => toggleName(staff.name)}
                                        className="w-5 h-5 accent-dd-green shrink-0"
                                    />
                                    <div className={`w-9 h-9 rounded-full flex items-center justify-center text-[12px] font-black shrink-0 ${isSelected ? 'bg-dd-green text-white' : 'bg-dd-sage-50 text-dd-green-700'}`}>
                                        {initials}
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <div className="text-sm font-bold text-dd-text truncate flex items-center gap-1.5">
                                            {staff.name}
                                            {isMe && (
                                                <span className="text-[9.5px] uppercase font-black text-dd-text-2">
                                                    {tx('you', 'tú')}
                                                </span>
                                            )}
                                        </div>
                                        {staff.role && (
                                            <div className="text-[10.5px] text-dd-text-2 truncate uppercase tracking-wider">
                                                {staff.role}
                                            </div>
                                        )}
                                    </div>
                                </label>
                            );
                        })
                    )}
                </div>

                {/* Footer */}
                <div className="px-4 py-3 border-t border-dd-line flex items-center gap-2 shrink-0 bg-white">
                    <span className="text-[11.5px] text-dd-text-2 flex-1">
                        {selected.size === 0
                            ? tx('No one assigned', 'Nadie asignado')
                            : selected.size === 1
                                ? `1 ${tx('person', 'persona')}`
                                : `${selected.size} ${tx('people', 'personas')}`}
                    </span>
                    <button
                        onClick={onClose}
                        disabled={saving}
                        className="px-4 py-2 rounded-lg border border-dd-line text-sm font-bold text-dd-text-2 hover:bg-dd-bg"
                    >
                        {tx('Cancel', 'Cancelar')}
                    </button>
                    <button
                        onClick={handleSave}
                        disabled={saving}
                        className="px-5 py-2 rounded-lg bg-dd-green text-white text-sm font-bold hover:bg-dd-green-700 disabled:opacity-60"
                    >
                        {saving ? tx('Saving…', 'Guardando…') : tx('Save', 'Guardar')}
                    </button>
                </div>
            </div>
        </div>
        </ModalPortal>
    );
}
