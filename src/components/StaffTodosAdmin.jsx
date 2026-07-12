// StaffTodosAdmin — admin section in AdminPanel for managing the
// custom todos that appear on staff Home pages.
//
// Workflow:
//   1. Admin sees a list of every existing custom todo (active +
//      archived), grouped active-first, with audience + ack counts.
//   2. Tap "+ Add" → composer pops open with EN/ES title + body,
//      audience picker (All staff / specific people), optional emoji
//      + deep-link.
//   3. Tap an existing row to edit OR archive it. Archived todos
//      stop appearing for staff but keep their completedBy audit
//      trail.
//
// Why a separate file: AdminPanel.jsx is already ~2700 lines. New
// admin features go in their own component to keep diffs reviewable.

import { useEffect, useState, useMemo } from 'react';
import {
    subscribeAllCustomTodos,
    createCustomTodo,
    updateCustomTodo,
    archiveCustomTodo,
    unarchiveCustomTodo,
    deleteCustomTodo,
} from '../data/staffTodos';
import { toast } from '../toast';
import ModalPortal from './ModalPortal';

const DEEP_LINKS = [
    { id: '',            en: '(none)',         es: '(ninguno)' },
    { id: 'schedule',    en: 'Schedule',       es: 'Horario' },
    { id: 'chat',        en: 'Chat',           es: 'Chat' },
    { id: 'operations',  en: 'Operations',     es: 'Operaciones' },
    { id: 'recipes',     en: 'Recipes',        es: 'Recetas' },
    { id: 'training',    en: 'Training',       es: 'Capacitación' },
    { id: 'menu',        en: 'Menu',           es: 'Menú' },
    { id: 'eighty6',     en: '86 Board',       es: 'Tablero 86' },
    { id: 'catering',    en: 'Catering',       es: 'Catering' },
    { id: 'maintenance', en: 'Maintenance',    es: 'Mantenimiento' },
    { id: 'insurance',   en: 'Insurance',      es: 'Seguro' },
];

export default function StaffTodosAdmin({ language = 'en', staffName, staffList = [] }) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);

    const [todos, setTodos] = useState([]);
    const [expanded, setExpanded] = useState(false);
    const [editing, setEditing] = useState(null); // null | 'new' | todoObj
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        const unsub = subscribeAllCustomTodos(setTodos);
        return () => { try { unsub && unsub(); } catch {} };
    }, []);

    const { active, archived } = useMemo(() => {
        const a = []; const z = [];
        for (const t of todos) {
            if (t.active === false) z.push(t);
            else a.push(t);
        }
        return { active: a, archived: z };
    }, [todos]);

    const closeEditor = () => setEditing(null);

    const handleArchive = async (todo) => {
        if (!confirm(tx(
            'Archive this todo? Staff will stop seeing it, but the ack history is kept.',
            '¿Archivar esta tarea? El personal dejará de verla, pero se conserva el historial.'))) return;
        setBusy(true);
        try {
            await archiveCustomTodo(todo.id);
            toast(tx('✓ Archived.', '✓ Archivado.'), { kind: 'success' });
        } catch (e) {
            toast(tx('Archive failed.', 'Error al archivar.'), { kind: 'error' });
        } finally { setBusy(false); }
    };

    const handleUnarchive = async (todo) => {
        setBusy(true);
        try {
            await unarchiveCustomTodo(todo.id);
            toast(tx('✓ Restored.', '✓ Restaurado.'), { kind: 'success' });
        } catch (e) {
            toast(tx('Restore failed.', 'Error al restaurar.'), { kind: 'error' });
        } finally { setBusy(false); }
    };

    const handleDelete = async (todo) => {
        if (!confirm(tx(
            'PERMANENTLY delete this todo? The ack audit trail is lost. Archive instead if unsure.',
            '¿Eliminar PERMANENTEMENTE esta tarea? Se pierde el historial. Mejor archivar si no estás seguro.'))) return;
        setBusy(true);
        try {
            await deleteCustomTodo(todo.id);
            toast(tx('✓ Deleted.', '✓ Eliminado.'), { kind: 'success' });
        } catch (e) {
            toast(tx('Delete failed.', 'Error al eliminar.'), { kind: 'error' });
        } finally { setBusy(false); }
    };

    return (
        <div className="mb-3">
            <button
                onClick={() => setExpanded(e => !e)}
                aria-expanded={expanded}
                className="glass-section-head tint-amber"
            >
                <div className="flex items-center gap-3 min-w-0">
                    <span className="glass-icon-tile" aria-hidden="true">✅</span>
                    <div className="text-left min-w-0">
                        <h3 className="font-bold text-[15px] text-dd-text">
                            {tx('Staff To-do List', 'Lista de Pendientes del Personal')}
                        </h3>
                        <p className="text-[11px] text-dd-text-2 truncate">
                            {active.length} {tx('active', 'activos')}
                            {archived.length > 0 && ` • ${archived.length} ${tx('archived', 'archivados')}`}
                            {' • '}
                            {tx(
                                'Shown on staff Home page',
                                'Se muestra en la página de inicio del personal',
                            )}
                        </p>
                    </div>
                </div>
                <span className="section-chevron text-xl" aria-hidden="true">›</span>
            </button>

            {expanded && (
                <div className="mt-2 bg-white border border-emerald-100 rounded-xl p-3 space-y-3">
                    <div className="flex items-center justify-between">
                        <p className="text-xs text-gray-600">
                            {tx(
                                'Custom todos appear on every targeted staff member\'s Home page until they tap "Done" or you archive the todo.',
                                'Las tareas personalizadas aparecen en el inicio del personal hasta que tocan "Listo" o archivas la tarea.',
                            )}
                        </p>
                        <button
                            onClick={() => setEditing('new')}
                            disabled={busy}
                            className="shrink-0 px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-xs font-bold hover:bg-emerald-700 active:scale-95 disabled:opacity-50 transition"
                        >
                            + {tx('Add', 'Agregar')}
                        </button>
                    </div>

                    {/* ACTIVE */}
                    {active.length === 0 ? (
                        <div className="text-center py-6 text-sm text-gray-500">
                            {tx(
                                'No active todos. Tap "+ Add" to create one.',
                                'No hay pendientes. Toca "+ Agregar" para crear uno.',
                            )}
                        </div>
                    ) : (
                        <ul className="divide-y divide-gray-100 border border-gray-100 rounded-lg overflow-hidden">
                            {active.map(t => (
                                <TodoRow
                                    key={t.id}
                                    todo={t}
                                    isEs={isEs}
                                    onEdit={() => setEditing(t)}
                                    onArchive={() => handleArchive(t)}
                                    onDelete={() => handleDelete(t)}
                                />
                            ))}
                        </ul>
                    )}

                    {/* ARCHIVED — collapsed by default visually */}
                    {archived.length > 0 && (
                        <details className="border border-gray-100 rounded-lg overflow-hidden">
                            <summary className="px-3 py-2 text-xs font-bold text-gray-600 cursor-pointer hover:bg-gray-50">
                                {tx('Archived', 'Archivados')} ({archived.length})
                            </summary>
                            <ul className="divide-y divide-gray-100">
                                {archived.map(t => (
                                    <TodoRow
                                        key={t.id}
                                        todo={t}
                                        isEs={isEs}
                                        archived
                                        onEdit={() => setEditing(t)}
                                        onUnarchive={() => handleUnarchive(t)}
                                        onDelete={() => handleDelete(t)}
                                    />
                                ))}
                            </ul>
                        </details>
                    )}
                </div>
            )}

            {editing && (
                <TodoEditor
                    todo={editing === 'new' ? null : editing}
                    staffList={staffList}
                    staffName={staffName}
                    isEs={isEs}
                    onClose={closeEditor}
                />
            )}
        </div>
    );
}

function TodoRow({ todo, isEs, archived, onEdit, onArchive, onUnarchive, onDelete }) {
    const title = isEs ? (todo.titleEs || todo.titleEn) : todo.titleEn;
    const aud = todo.audience;
    const ackCount = todo.completedBy ? Object.keys(todo.completedBy).length : 0;
    const audLabel = aud === 'all'
        ? (isEs ? 'Todos' : 'All staff')
        : Array.isArray(aud)
            ? `${aud.length} ${isEs ? 'persona(s)' : 'person(s)'}`
            : (isEs ? '(no asignado)' : '(no audience)');
    return (
        <li className={`px-3 py-2 flex items-start gap-2 ${archived ? 'opacity-60' : ''}`}>
            <span className="text-lg shrink-0">{todo.emoji || '📌'}</span>
            <div className="flex-1 min-w-0">
                <div className="text-sm font-bold text-gray-800 truncate">{title || '—'}</div>
                <div className="text-[10px] text-gray-500 flex gap-2 flex-wrap mt-0.5">
                    <span>👥 {audLabel}</span>
                    <span>✓ {ackCount} {isEs ? 'completaron' : 'done'}</span>
                    {todo.deepLink && <span>→ {todo.deepLink}</span>}
                </div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
                <button onClick={onEdit}
                    className="px-2 py-1 text-[11px] font-bold text-gray-700 hover:bg-gray-100 rounded">
                    {isEs ? 'Editar' : 'Edit'}
                </button>
                {!archived && (
                    <button onClick={onArchive}
                        className="px-2 py-1 text-[11px] font-bold text-amber-700 hover:bg-amber-50 rounded">
                        {isEs ? 'Archivar' : 'Archive'}
                    </button>
                )}
                {archived && (
                    <button onClick={onUnarchive}
                        className="px-2 py-1 text-[11px] font-bold text-emerald-700 hover:bg-emerald-50 rounded">
                        {isEs ? 'Restaurar' : 'Restore'}
                    </button>
                )}
                <button onClick={onDelete}
                    className="px-2 py-1 text-[11px] font-bold text-red-700 hover:bg-red-50 rounded">
                    {isEs ? 'Borrar' : 'Delete'}
                </button>
            </div>
        </li>
    );
}

function TodoEditor({ todo, staffList, staffName, isEs, onClose }) {
    const tx = (en, es) => (isEs ? es : en);
    const isNew = !todo;
    const [titleEn, setTitleEn] = useState(todo?.titleEn || '');
    const [titleEs, setTitleEs] = useState(todo?.titleEs || '');
    const [bodyEn,  setBodyEn]  = useState(todo?.bodyEn || '');
    const [bodyEs,  setBodyEs]  = useState(todo?.bodyEs || '');
    const [emoji,   setEmoji]   = useState(todo?.emoji || '📌');
    const [audienceMode, setAudienceMode] = useState(
        todo?.audience === 'all' || todo?.audience == null ? 'all' : 'specific'
    );
    const [audienceNames, setAudienceNames] = useState(
        Array.isArray(todo?.audience) ? todo.audience : []
    );
    const [deepLink, setDeepLink] = useState(todo?.deepLink || '');
    const [saving, setSaving] = useState(false);

    const canSave = titleEn.trim().length > 0 && (audienceMode === 'all' || audienceNames.length > 0);

    const toggleName = (name) => {
        setAudienceNames(prev => prev.includes(name) ? prev.filter(n => n !== name) : [...prev, name]);
    };

    const handleSave = async () => {
        if (!canSave || saving) return;
        setSaving(true);
        try {
            const payload = {
                titleEn: titleEn.trim(),
                titleEs: (titleEs || titleEn).trim(),
                bodyEn:  bodyEn.trim(),
                bodyEs:  (bodyEs || bodyEn).trim(),
                emoji:   emoji || '📌',
                audience: audienceMode === 'all' ? 'all' : audienceNames,
                deepLink: deepLink || null,
            };
            if (isNew) {
                await createCustomTodo({ ...payload, createdBy: staffName });
                toast(tx('✓ Todo added.', '✓ Tarea agregada.'), { kind: 'success' });
            } else {
                await updateCustomTodo(todo.id, payload);
                toast(tx('✓ Saved.', '✓ Guardado.'), { kind: 'success' });
            }
            onClose();
        } catch (e) {
            console.warn('todo save failed:', e);
            toast(tx('Save failed: ', 'Error: ') + (e.message || e), { kind: 'error' });
        } finally {
            setSaving(false);
        }
    };

    // Dedup staff names (handle the rare case of duplicate entries).
    const uniqueNames = useMemo(() => {
        const seen = new Set();
        return (staffList || [])
            .filter(s => s && s.name)
            .filter(s => { if (seen.has(s.name)) return false; seen.add(s.name); return true; })
            .sort((a, b) => a.name.localeCompare(b.name));
    }, [staffList]);

    return (
        <ModalPortal>
        <div className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={onClose}>
            <div onClick={(e) => e.stopPropagation()}
                className="bg-white w-full sm:max-w-lg sm:rounded-2xl rounded-t-2xl max-h-[92vh] flex flex-col">
                <div className="border-b border-gray-200 p-4 flex items-center justify-between sticky top-0 bg-white">
                    <h3 className="text-lg font-bold text-emerald-700">
                        {isNew ? tx('New Todo', 'Nueva Tarea') : tx('Edit Todo', 'Editar Tarea')}
                    </h3>
                    <button onClick={onClose}
                        className="w-8 h-8 rounded-full bg-gray-100 text-gray-600 hover:bg-gray-200 text-lg">×</button>
                </div>

                <div className="flex-1 overflow-y-auto p-4 space-y-4">
                    {/* Emoji */}
                    <div>
                        <label className="text-xs font-bold text-gray-600 uppercase tracking-wide block mb-1">
                            {tx('Icon', 'Ícono')}
                        </label>
                        <input
                            value={emoji}
                            onChange={(e) => setEmoji(e.target.value)}
                            maxLength={4}
                            placeholder="📌"
                            className="w-16 text-center text-2xl border-2 border-gray-200 rounded-lg py-1 focus:border-emerald-500 focus:outline-none"
                        />
                    </div>

                    {/* Title EN/ES */}
                    <div>
                        <label className="text-xs font-bold text-gray-600 uppercase tracking-wide block mb-1">
                            {tx('Title — English', 'Título — Inglés')} *
                        </label>
                        <input
                            value={titleEn}
                            onChange={(e) => setTitleEn(e.target.value)}
                            placeholder={tx('Pick up your work shirt', 'Recoge tu camiseta de trabajo')}
                            className="w-full px-3 py-2 text-sm border-2 border-gray-200 rounded-lg focus:border-emerald-500 focus:outline-none"
                        />
                    </div>
                    <div>
                        <label className="text-xs font-bold text-gray-600 uppercase tracking-wide block mb-1">
                            {tx('Title — Spanish', 'Título — Español')}
                        </label>
                        <input
                            value={titleEs}
                            onChange={(e) => setTitleEs(e.target.value)}
                            placeholder={tx('Optional — auto-fills from English', 'Opcional — se autocompleta del inglés')}
                            className="w-full px-3 py-2 text-sm border-2 border-gray-200 rounded-lg focus:border-emerald-500 focus:outline-none"
                        />
                    </div>

                    {/* Body EN/ES */}
                    <div>
                        <label className="text-xs font-bold text-gray-600 uppercase tracking-wide block mb-1">
                            {tx('Details — English', 'Detalles — Inglés')}
                        </label>
                        <textarea
                            value={bodyEn}
                            onChange={(e) => setBodyEn(e.target.value)}
                            rows={2}
                            placeholder={tx('Optional. e.g. "It\'s at Webster, ask Brandon."', 'Opcional. p.ej. "Está en Webster, pregúntale a Brandon."')}
                            className="w-full px-3 py-2 text-sm border-2 border-gray-200 rounded-lg focus:border-emerald-500 focus:outline-none resize-none"
                        />
                    </div>
                    <div>
                        <label className="text-xs font-bold text-gray-600 uppercase tracking-wide block mb-1">
                            {tx('Details — Spanish', 'Detalles — Español')}
                        </label>
                        <textarea
                            value={bodyEs}
                            onChange={(e) => setBodyEs(e.target.value)}
                            rows={2}
                            placeholder={tx('Optional — auto-fills from English', 'Opcional — se autocompleta del inglés')}
                            className="w-full px-3 py-2 text-sm border-2 border-gray-200 rounded-lg focus:border-emerald-500 focus:outline-none resize-none"
                        />
                    </div>

                    {/* Deep link */}
                    <div>
                        <label className="text-xs font-bold text-gray-600 uppercase tracking-wide block mb-1">
                            {tx('Deep-link to tab (optional)', 'Ir a pestaña (opcional)')}
                        </label>
                        <select
                            value={deepLink}
                            onChange={(e) => setDeepLink(e.target.value)}
                            className="w-full px-3 py-2 text-sm border-2 border-gray-200 rounded-lg focus:border-emerald-500 focus:outline-none bg-white"
                        >
                            {DEEP_LINKS.map(l => (
                                <option key={l.id} value={l.id}>{isEs ? l.es : l.en}</option>
                            ))}
                        </select>
                        <p className="text-[10px] text-gray-500 mt-1">
                            {tx('When set, tapping the todo navigates here.', 'Si está, tocar la tarea navega aquí.')}
                        </p>
                    </div>

                    {/* Audience */}
                    <div>
                        <label className="text-xs font-bold text-gray-600 uppercase tracking-wide block mb-1">
                            {tx('Audience', 'Audiencia')} *
                        </label>
                        <div className="flex gap-2 mb-2">
                            <button
                                type="button"
                                onClick={() => setAudienceMode('all')}
                                className={`flex-1 px-3 py-2 rounded-lg text-xs font-bold border-2 transition ${
                                    audienceMode === 'all'
                                        ? 'bg-emerald-600 text-white border-emerald-600'
                                        : 'bg-white text-emerald-700 border-emerald-300 hover:bg-emerald-50'
                                }`}
                            >
                                {tx('All staff', 'Todo el personal')}
                            </button>
                            <button
                                type="button"
                                onClick={() => setAudienceMode('specific')}
                                className={`flex-1 px-3 py-2 rounded-lg text-xs font-bold border-2 transition ${
                                    audienceMode === 'specific'
                                        ? 'bg-emerald-600 text-white border-emerald-600'
                                        : 'bg-white text-emerald-700 border-emerald-300 hover:bg-emerald-50'
                                }`}
                            >
                                {tx('Specific people', 'Personas específicas')}
                            </button>
                        </div>
                        {audienceMode === 'specific' && (
                            <div className="max-h-48 overflow-y-auto border-2 border-gray-200 rounded-lg p-2 space-y-0.5">
                                {uniqueNames.length === 0 ? (
                                    <p className="text-xs text-gray-500 text-center py-2">
                                        {tx('No staff yet', 'No hay personal aún')}
                                    </p>
                                ) : uniqueNames.map(s => {
                                    const selected = audienceNames.includes(s.name);
                                    return (
                                        <label key={s.id || s.name}
                                            className={`flex items-center gap-2 px-2 py-1 rounded text-sm cursor-pointer transition ${selected ? 'bg-emerald-50' : 'hover:bg-gray-50'}`}
                                        >
                                            <input
                                                type="checkbox"
                                                checked={selected}
                                                onChange={() => toggleName(s.name)}
                                                className="accent-emerald-600"
                                            />
                                            <span className="flex-1 truncate">{s.name}</span>
                                            <span className="text-[10px] text-gray-400 shrink-0">{s.role || ''}</span>
                                        </label>
                                    );
                                })}
                            </div>
                        )}
                        {audienceMode === 'specific' && audienceNames.length > 0 && (
                            <p className="text-[10px] text-gray-600 mt-1">
                                {audienceNames.length} {tx('selected', 'seleccionado(s)')}
                            </p>
                        )}
                    </div>
                </div>

                <div className="border-t border-gray-200 p-3 flex gap-2 sticky bottom-0 bg-white">
                    <button
                        onClick={onClose}
                        className="flex-1 py-2.5 rounded-lg bg-gray-100 text-gray-700 text-sm font-bold hover:bg-gray-200 transition"
                    >
                        {tx('Cancel', 'Cancelar')}
                    </button>
                    <button
                        onClick={handleSave}
                        disabled={!canSave || saving}
                        className="flex-1 py-2.5 rounded-lg bg-emerald-600 text-white text-sm font-bold hover:bg-emerald-700 active:scale-95 disabled:opacity-50 transition"
                    >
                        {saving
                            ? tx('Saving…', 'Guardando…')
                            : (isNew ? tx('Create', 'Crear') : tx('Save', 'Guardar'))}
                    </button>
                </div>
            </div>
        </div>
        </ModalPortal>
    );
}
