// WallTasksAdmin — admin panel for editing the wall-tablet task list.
// Mounted as a sub-tab inside Operations (Operations → "📺 Wall").
//
// Manager adds / removes / reorders the short task list that shows on
// the kitchen wall tablet (TaskDisplay.jsx rendered at the URL shown
// at the bottom of this panel).
//
// Side / location scoping:
//   • Admin sees a FOH/BOH + location picker.
//   • Non-admin manager is locked to their own side (inferred from
//     staff record, same heuristic as Operations checklist tab).
//   • Location follows the user's storeLocation prop, with a picker
//     when they're on 'both'.

import { useEffect, useMemo, useState } from 'react';
import {
    subscribeWallTasks,
    addWallTask,
    removeWallTask,
    updateWallTask,
    moveWallTask,
    resetWallTasks,
} from '../data/wallTasks';
import { inferStaffSide } from '../data/assignedTasks';

const tx = (en, es, isEs) => (isEs ? es : en);

export default function WallTasksAdmin({
    language = 'en',
    staffName = '',
    staffList = [],
    storeLocation = 'webster',
    isAdmin = false,
}) {
    const isEs = language === 'es';

    // Side — admin can flip; non-admin is locked.
    const me = useMemo(
        () => (staffList || []).find((s) => s.name === staffName) || null,
        [staffList, staffName]
    );
    const myInferredSide = inferStaffSide(me) || 'FOH';
    const [side, setSide] = useState(myInferredSide);
    useEffect(() => {
        if (!isAdmin) setSide(myInferredSide);
    }, [isAdmin, myInferredSide]);

    // Location — picker when storeLocation is 'both' (admin / 2-store
    // staff), pinned otherwise.
    const [location, setLocation] = useState(
        storeLocation === 'both' ? 'webster' : storeLocation
    );
    useEffect(() => {
        if (storeLocation !== 'both') setLocation(storeLocation);
    }, [storeLocation]);

    // Subscribe.
    const [items, setItems] = useState([]);
    const [lastResetAt, setLastResetAt] = useState(null);
    useEffect(() => subscribeWallTasks(location, side, (data) => {
        setItems(data.items);
        setLastResetAt(data.lastResetAt);
    }), [location, side]);

    // Add input.
    const [newTask, setNewTask] = useState('');
    const [editingId, setEditingId] = useState(null);
    const [editText, setEditText] = useState('');

    async function handleAdd(e) {
        e?.preventDefault?.();
        const t = newTask.trim();
        if (!t) return;
        try {
            await addWallTask(location, side, t);
            setNewTask('');
        } catch (err) {
            console.warn('addWallTask failed:', err);
        }
    }

    async function handleRemove(itemId) {
        if (!window.confirm(tx('Remove this task from the wall?', '¿Eliminar esta tarea del muro?', isEs))) return;
        try { await removeWallTask(location, side, itemId); }
        catch (err) { console.warn('removeWallTask failed:', err); }
    }

    async function handleEditSave(itemId) {
        const t = editText.trim();
        if (!t) { setEditingId(null); return; }
        try {
            await updateWallTask(location, side, itemId, { task: t });
        } catch (err) {
            console.warn('updateWallTask failed:', err);
        }
        setEditingId(null);
    }

    async function handleMove(fromIdx, dir) {
        const toIdx = fromIdx + dir;
        if (toIdx < 0 || toIdx >= items.length) return;
        try { await moveWallTask(location, side, fromIdx, toIdx); }
        catch (err) { console.warn('moveWallTask failed:', err); }
    }

    async function handleReset() {
        if (!window.confirm(tx(
            'Reset all checkmarks on the wall? Tasks themselves stay.',
            '¿Reiniciar todas las marcas en el muro? Las tareas siguen.',
            isEs
        ))) return;
        try { await resetWallTasks(location, side); }
        catch (err) { console.warn('resetWallTasks failed:', err); }
    }

    // Build the wall display URL the manager scans / pastes into the
    // tablet's kiosk browser. Uses the current origin so dev → dev and
    // prod → prod without manual edits.
    const displayUrl = useMemo(() => {
        if (typeof window === 'undefined') return '';
        return `${window.location.origin}${window.location.pathname}?display=walltasks&side=${side}&location=${location}`;
    }, [side, location]);

    function copyDisplayUrl() {
        try {
            navigator.clipboard?.writeText(displayUrl);
        } catch {}
    }

    const completedCount = items.filter((it) => it.done).length;

    return (
        <div className="space-y-3">
            {/* Header — side + location picker */}
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
                                        onClick={() => setSide(s)}
                                        className={`px-3 py-1.5 rounded-md text-xs font-bold transition ${
                                            side === s ? 'bg-dd-green text-white shadow-sm' : 'text-dd-text-2 hover:text-dd-text'
                                        }`}>
                                        {s}
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}
                    {storeLocation === 'both' && (
                        <div className="flex flex-col">
                            <span className="text-[10px] font-bold text-dd-text-2 uppercase tracking-wide mb-1">
                                {tx('Location', 'Ubicación', isEs)}
                            </span>
                            <div className="flex gap-1 bg-dd-bg border border-dd-line rounded-lg p-1">
                                {[
                                    { id: 'webster', label: 'Webster' },
                                    { id: 'maryland', label: 'Maryland Heights' },
                                ].map((loc) => (
                                    <button key={loc.id}
                                        onClick={() => setLocation(loc.id)}
                                        className={`px-3 py-1.5 rounded-md text-xs font-bold transition ${
                                            location === loc.id ? 'bg-dd-green text-white shadow-sm' : 'text-dd-text-2 hover:text-dd-text'
                                        }`}>
                                        {loc.label}
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}
                    <div className="flex-1 min-w-[180px]">
                        <span className="block text-[10px] font-bold text-dd-text-2 uppercase tracking-wide mb-1">
                            {tx('Status', 'Estado', isEs)}
                        </span>
                        <div className="text-sm text-dd-text">
                            <span className="font-bold">{completedCount}</span>
                            <span className="text-dd-text-2"> / {items.length} {tx('done', 'hechas', isEs)}</span>
                            {lastResetAt && (
                                <span className="text-xs text-dd-text-2 ml-2">
                                    {tx('· last reset', '· último reinicio', isEs)}{' '}
                                    {lastResetAt.toDate
                                        ? lastResetAt.toDate().toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
                                        : ''}
                                </span>
                            )}
                        </div>
                    </div>
                    <button onClick={handleReset}
                        disabled={items.length === 0}
                        className="px-3 py-2 bg-dd-bg border border-dd-line text-dd-text rounded-lg text-xs font-bold hover:bg-white disabled:opacity-40">
                        🔄 {tx('Reset all', 'Reiniciar todo', isEs)}
                    </button>
                </div>
            </div>

            {/* Add task */}
            <form onSubmit={handleAdd}
                className="bg-white border border-dd-line rounded-xl p-3 shadow-card flex gap-2">
                <input type="text"
                    value={newTask}
                    onChange={(e) => setNewTask(e.target.value)}
                    placeholder={tx(
                        `Add a task to the ${side} wall (${location})…`,
                        `Añadir tarea al muro ${side} (${location})…`,
                        isEs
                    )}
                    className="flex-1 border border-dd-line rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-dd-green/30"
                />
                <button type="submit"
                    disabled={!newTask.trim()}
                    className="bg-dd-green text-white px-4 py-2 rounded-lg text-sm font-bold disabled:opacity-40 active:scale-95 transition">
                    {tx('Add', 'Añadir', isEs)}
                </button>
            </form>

            {/* Task list */}
            <div className="bg-white border border-dd-line rounded-xl p-3 shadow-card">
                {items.length === 0 ? (
                    <div className="text-sm text-dd-text-2 text-center py-8">
                        {tx(
                            'No tasks yet. Add the first one above — it shows up on the wall instantly.',
                            'Sin tareas. Añade la primera arriba — aparece en el muro al instante.',
                            isEs
                        )}
                    </div>
                ) : (
                    <ul className="space-y-1.5">
                        {items.map((it, idx) => (
                            <li key={it.id}
                                className={`flex items-center gap-2 px-3 py-2 rounded-lg border transition ${
                                    it.done
                                        ? 'bg-dd-bg border-dd-line opacity-60'
                                        : 'bg-white border-dd-line'
                                }`}>
                                <div className="flex flex-col gap-0.5 flex-shrink-0">
                                    <button onClick={() => handleMove(idx, -1)}
                                        disabled={idx === 0}
                                        className="text-dd-text-2 hover:text-dd-green disabled:opacity-30 text-xs leading-none px-1"
                                        aria-label="Move up">▲</button>
                                    <button onClick={() => handleMove(idx, +1)}
                                        disabled={idx === items.length - 1}
                                        className="text-dd-text-2 hover:text-dd-green disabled:opacity-30 text-xs leading-none px-1"
                                        aria-label="Move down">▼</button>
                                </div>
                                {editingId === it.id ? (
                                    <input type="text"
                                        autoFocus
                                        value={editText}
                                        onChange={(e) => setEditText(e.target.value)}
                                        onBlur={() => handleEditSave(it.id)}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter') handleEditSave(it.id);
                                            if (e.key === 'Escape') setEditingId(null);
                                        }}
                                        className="flex-1 border border-dd-green rounded px-2 py-1 text-sm" />
                                ) : (
                                    <button
                                        onClick={() => { setEditingId(it.id); setEditText(it.task); }}
                                        className={`flex-1 text-left text-sm truncate ${it.done ? 'line-through' : ''}`}
                                        title={tx('Click to edit', 'Haz clic para editar', isEs)}>
                                        {it.task}
                                    </button>
                                )}
                                {it.done && (
                                    <span className="text-xs text-dd-green flex-shrink-0">✓ {tx('done', 'hecho', isEs)}</span>
                                )}
                                <button onClick={() => handleRemove(it.id)}
                                    className="text-dd-text-2 hover:text-red-500 text-lg leading-none px-1 flex-shrink-0"
                                    aria-label="Remove">×</button>
                            </li>
                        ))}
                    </ul>
                )}
            </div>

            {/* Wall display URL */}
            <div className="bg-dd-bg border border-dd-line rounded-xl p-3 shadow-card">
                <div className="text-xs font-bold text-dd-text-2 uppercase tracking-wide mb-1">
                    📺 {tx('Wall display URL', 'URL del muro', isEs)}
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                    <code className="flex-1 min-w-[200px] bg-white border border-dd-line rounded px-2 py-1.5 text-xs font-mono text-dd-text break-all">
                        {displayUrl}
                    </code>
                    <button onClick={copyDisplayUrl}
                        className="px-3 py-1.5 bg-dd-green text-white rounded-lg text-xs font-bold active:scale-95 transition">
                        📋 {tx('Copy', 'Copiar', isEs)}
                    </button>
                    <a href={displayUrl} target="_blank" rel="noopener noreferrer"
                        className="px-3 py-1.5 bg-white border border-dd-line text-dd-text rounded-lg text-xs font-bold hover:bg-dd-bg">
                        🔗 {tx('Preview', 'Vista previa', isEs)}
                    </a>
                </div>
                <p className="text-xs text-dd-text-2 mt-2">
                    {tx(
                        `Open this URL on the wall tablet. It bypasses the PIN screen and renders the ${side} list for ${location} in full-screen kiosk mode. Tap any card to toggle done.`,
                        `Abre esta URL en la tableta del muro. Omite el PIN y muestra la lista de ${side} para ${location} en pantalla completa. Toca una tarjeta para marcar hecho.`,
                        isEs
                    )}
                </p>
            </div>
        </div>
    );
}
