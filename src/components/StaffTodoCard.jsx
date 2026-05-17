// StaffTodoCard — the "you still need to..." card on the Home page.
//
// Combines two sources into a single list:
//   • AUTO todos — computed from the current staff record (missing
//     birthday, missing weekly availability). Tapping one navigates to
//     Schedule with a sessionStorage hint that auto-opens the right
//     self-serve modal.
//   • CUSTOM todos — admin-defined in /staff_todos. Tap "Done" to ack;
//     the doc records who acked + when. Optional deepLink jumps you
//     to the relevant tab on tap.
//
// Renders null when the combined list is empty (zero noise on the
// happy path).

import { useEffect, useState } from 'react';
import {
    getAutoTodos, subscribeCustomTodos, markTodoDone, OPEN_MODAL_KEY,
} from '../data/staffTodos';
import { toast } from '../toast';

export default function StaffTodoCard({
    language = 'en',
    staffName,
    viewer,           // the current staff record from staffList
    onNavigate,       // (tab) => void — usually App.jsx's setActiveTab
}) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);

    const [customTodos, setCustomTodos] = useState([]);
    const [busyId, setBusyId] = useState(null);

    // Subscribe to admin-defined todos for this staff. Re-runs on
    // staffName change (sign-in / sign-out).
    useEffect(() => {
        if (!staffName) {
            setCustomTodos([]);
            return;
        }
        const unsub = subscribeCustomTodos(staffName, setCustomTodos);
        return () => { try { unsub && unsub(); } catch {} };
    }, [staffName]);

    // Auto todos recompute on every render — they're cheap (just reads
    // a couple fields off viewer). When the underlying field is filled
    // and viewer updates via the live staff snapshot, the todo
    // disappears.
    const autoTodos = getAutoTodos(viewer);

    const all = [...autoTodos, ...customTodos];
    if (all.length === 0) return null;

    const handleTap = (todo) => {
        // Auto todos with an openModal hint: stash the marker in
        // sessionStorage so the target tab can auto-open the right
        // modal on mount. We use sessionStorage (not localStorage) so
        // the hint doesn't survive a hard reload or a different tab.
        if (todo.openModal) {
            try { sessionStorage.setItem(OPEN_MODAL_KEY, todo.openModal); } catch {}
        }
        if (todo.deepLink && onNavigate) {
            onNavigate(todo.deepLink);
        }
    };

    const handleDone = async (todo, e) => {
        // Stop the row's onClick from also firing (navigation).
        e?.stopPropagation?.();
        if (busyId || todo.kind !== 'custom') return;
        setBusyId(todo.id);
        try {
            await markTodoDone(todo.id, staffName);
            // Optimistic: filter out locally so the row vanishes
            // immediately even before the snapshot lands.
            setCustomTodos(prev => prev.filter(t => t.id !== todo.id));
        } catch (err) {
            console.warn('markTodoDone failed:', err);
            toast(tx('Could not save. Try again.', 'No se pudo guardar. Intenta de nuevo.'),
                { kind: 'error' });
        } finally {
            setBusyId(null);
        }
    };

    return (
        <section className="bg-white border-2 border-dd-green/20 rounded-xl shadow-card overflow-hidden">
            {/* Header strip — accent color so the card reads as
                "action needed" without being loud. */}
            <header className="flex items-center justify-between px-4 py-2.5 bg-dd-sage-50 border-b border-dd-green/20">
                <div className="flex items-center gap-2 min-w-0">
                    <span className="text-base">✅</span>
                    <h2 className="text-[13px] font-black text-dd-text tracking-tight truncate">
                        {tx('To do', 'Pendientes')}
                    </h2>
                </div>
                <span className="shrink-0 min-w-[20px] h-[20px] px-1.5 rounded-full bg-dd-green text-white text-[10px] font-black flex items-center justify-center tabular-nums">
                    {all.length}
                </span>
            </header>

            {/* Body — one row per todo */}
            <ul className="divide-y divide-dd-line">
                {all.map(todo => {
                    const title = isEs ? (todo.titleEs || todo.titleEn) : todo.titleEn;
                    const body  = isEs ? (todo.bodyEs  || todo.bodyEn ) : todo.bodyEn;
                    const isCustom = todo.kind === 'custom';
                    return (
                        <li key={todo.id}>
                            <button
                                onClick={() => handleTap(todo)}
                                className="w-full text-left px-3 py-2.5 hover:bg-dd-bg active:bg-dd-bg transition flex items-start gap-3"
                            >
                                <span className="flex-shrink-0 w-9 h-9 rounded-lg bg-dd-sage-50 flex items-center justify-center text-[18px] leading-none">
                                    {todo.emoji || '📌'}
                                </span>
                                <div className="flex-1 min-w-0">
                                    <div className="text-sm font-bold text-dd-text leading-snug">
                                        {title || tx('Untitled', 'Sin título')}
                                    </div>
                                    {body && (
                                        <p className="text-[12px] text-dd-text-2 leading-snug mt-0.5">
                                            {body}
                                        </p>
                                    )}
                                </div>
                                {/* Custom todos get a Done button so staff
                                    can ack without navigating. Auto todos
                                    DON'T — they disappear automatically
                                    when the underlying field is filled,
                                    so a Done button would be misleading
                                    (the prompt would re-appear on the
                                    next refresh).  */}
                                {isCustom ? (
                                    <button
                                        onClick={(e) => handleDone(todo, e)}
                                        disabled={busyId === todo.id}
                                        className="shrink-0 px-2.5 py-1 rounded-full bg-dd-green text-white text-[11px] font-black hover:bg-dd-green-700 active:scale-95 disabled:opacity-50 transition"
                                    >
                                        {busyId === todo.id
                                            ? tx('…', '…')
                                            : tx('Done', 'Listo')}
                                    </button>
                                ) : (
                                    <span className="shrink-0 text-dd-text-2/60 text-base self-center">→</span>
                                )}
                            </button>
                        </li>
                    );
                })}
            </ul>
        </section>
    );
}
