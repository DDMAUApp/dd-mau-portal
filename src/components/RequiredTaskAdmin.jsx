// Admin sub-page — push required tasks to one, some, or all staff.
//
// Two surfaces:
//   1. Compose: pick task type → pick recipients → confirm + push
//   2. Campaigns: list of pushed campaigns with completion stats,
//      drill-in to see per-staff status, cancel pending tasks if
//      pushed by mistake
//
// Mounted from AdminPanel via a button. Not a top-level tab — this
// is an admin-only workflow, kept off the main nav.

import { useState, useEffect, useMemo } from 'react';
import { db } from '../firebase';
import {
    collection, getDocs, query, where, orderBy, onSnapshot, limit,
} from 'firebase/firestore';
import {
    TASK_TYPES, TASK_TYPE_IDS, TASK_STATUS,
    createTaskCampaign, cancelTask,
} from '../data/requiredTasks';
import { toast } from '../toast';
import ModalPortal from './ModalPortal';

export default function RequiredTaskAdmin({ staffList, staffName, language, onClose }) {
    const isEs = language === 'es';
    const tx = (en, es) => isEs ? es : en;

    const [view, setView] = useState('compose');     // 'compose' | 'campaigns'
    const [selectedType, setSelectedType] = useState('sms_optin');
    const [selectedIds, setSelectedIds] = useState(new Set());
    const [allowSkip, setAllowSkip] = useState(false);
    const [blockApp, setBlockApp] = useState(true);
    const [search, setSearch] = useState('');
    const [filterLocation, setFilterLocation] = useState('all');  // all/webster/maryland
    const [filterSide, setFilterSide] = useState('all');          // all/foh/boh
    const [pushing, setPushing] = useState(false);

    // ── Recipient filtering ────────────────────────────────────────
    // Same model as the AdminPanel staff list: filter by location,
    // side, free-text. Plus smart "missing X" filters that key off
    // the task type — for sms_optin, "missing" means not opted in;
    // for availability, "missing" means staff.availability is empty.
    const visibleStaff = useMemo(() => {
        const tNorm = search.trim().toLowerCase();
        return (staffList || []).filter(s => {
            if (!s || !s.name) return false;
            if (s.hideFromSchedule) return false;            // owners w/ no grid row
            if (filterLocation !== 'all') {
                if (s.location !== filterLocation && s.location !== 'both') return false;
            }
            if (filterSide !== 'all') {
                if ((s.scheduleSide || 'foh') !== filterSide) return false;
            }
            if (tNorm && !s.name.toLowerCase().includes(tNorm) && !(s.role || '').toLowerCase().includes(tNorm)) {
                return false;
            }
            return true;
        });
    }, [staffList, search, filterLocation, filterSide]);

    // Smart-filter shortcut: select only staff who need THIS task type
    const selectStaffMissingThisTask = () => {
        const typeDef = TASK_TYPES[selectedType];
        if (!typeDef) return;
        const ids = new Set();
        for (const s of visibleStaff) {
            // "Missing" = autoComplete predicate returns FALSE on
            // this staff — i.e. the task would not auto-resolve and
            // therefore is still meaningful for them.
            try {
                if (!typeDef.autoComplete(s)) ids.add(s.id);
            } catch { /* ignore individual evaluation errors */ }
        }
        setSelectedIds(ids);
    };

    const selectAll = () => setSelectedIds(new Set(visibleStaff.map(s => s.id)));
    const clearSelection = () => setSelectedIds(new Set());
    const toggleStaff = (id) => {
        setSelectedIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    };

    const selectedCount = selectedIds.size;

    // Reset block/skip defaults whenever the type changes — the
    // defaults come from the registry.
    useEffect(() => {
        const typeDef = TASK_TYPES[selectedType];
        if (!typeDef) return;
        setBlockApp(typeDef.defaultBlockApp);
        setAllowSkip(typeDef.defaultAllowSkip);
    }, [selectedType]);

    const handlePush = async () => {
        if (selectedCount === 0) {
            toast(tx('Pick at least one person', 'Selecciona al menos una persona'), { kind: 'error' });
            return;
        }
        if (!TASK_TYPES[selectedType]) return;
        if (!confirm(tx(
            `Push "${TASK_TYPES[selectedType].labelEn}" to ${selectedCount} staff?`,
            `¿Enviar "${TASK_TYPES[selectedType].labelEs}" a ${selectedCount} miembros?`,
        ))) return;
        setPushing(true);
        try {
            const recipients = (staffList || [])
                .filter(s => selectedIds.has(s.id))
                .map(s => ({ name: s.name, id: s.id }));
            const result = await createTaskCampaign({
                taskType: selectedType,
                recipients,
                createdBy: staffName || 'admin',
                blockApp,
                allowSkip,
            });
            toast(tx(
                `Pushed: ${result.created} created, ${result.skipped} already had one pending`,
                `Enviado: ${result.created} creados, ${result.skipped} ya tenían pendiente`,
            ));
            clearSelection();
        } catch (e) {
            console.error('push campaign failed:', e);
            toast(tx('Push failed. Try again.', 'Error al enviar.'), { kind: 'error' });
        } finally {
            setPushing(false);
        }
    };

    // ── Campaigns view (live snapshot) ─────────────────────────────
    const [campaigns, setCampaigns] = useState([]);
    useEffect(() => {
        if (view !== 'campaigns') return;
        // Live snapshot of all required tasks — we group by campaign
        // on the client. For DD Mau scale (hundreds of rows max) this
        // is fine. If volume grows past a few thousand we add a
        // /campaigns aggregate doc.
        //
        // PERF, 2026-06-02 audit: bounded at 500. The collection is
        // grow-only (cancelled/completed rows are never archived) so
        // an unbounded orderBy('createdAt','desc') would stream every
        // historical task to every admin who opens this tab — easily
        // thousands once the restaurant runs a few months of opt-in /
        // availability / i9 campaigns. 500 newest rows comfortably
        // covers the last ~10 campaigns at DD Mau's scale; older
        // campaigns can be surfaced via a "load older" cursor if/when
        // anyone asks. Status-based scoping isn't usable here because
        // the campaigns view counts ALL statuses (completed, pending,
        // skipped, cancelled) to render completion stats.
        const q = query(
            collection(db, 'required_tasks'),
            orderBy('createdAt', 'desc'),
            limit(500),
        );
        const unsub = onSnapshot(q, (snap) => {
            const byCampaign = new Map();
            for (const d of snap.docs) {
                const t = { id: d.id, ...d.data() };
                if (!t.campaignId) continue;
                if (!byCampaign.has(t.campaignId)) {
                    byCampaign.set(t.campaignId, {
                        campaignId: t.campaignId,
                        taskType: t.taskType,
                        createdAt: t.createdAt,
                        createdBy: t.createdBy,
                        tasks: [],
                        completed: 0,
                        pending: 0,
                        skipped: 0,
                        cancelled: 0,
                    });
                }
                const c = byCampaign.get(t.campaignId);
                c.tasks.push(t);
                if (t.status === TASK_STATUS.COMPLETED) c.completed++;
                else if (t.status === TASK_STATUS.PENDING) c.pending++;
                else if (t.status === TASK_STATUS.SKIPPED) c.skipped++;
                else if (t.status === TASK_STATUS.CANCELLED) c.cancelled++;
            }
            const list = Array.from(byCampaign.values());
            list.sort((a, b) => {
                const at = a.createdAt?.toMillis?.() ?? 0;
                const bt = b.createdAt?.toMillis?.() ?? 0;
                return bt - at;
            });
            setCampaigns(list);
        }, (err) => console.warn('required_tasks campaigns snapshot failed:', err));
        return () => unsub();
    }, [view]);

    const [expandedCampaign, setExpandedCampaign] = useState(null);

    return (
        <ModalPortal>
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-0 sm:p-4">
            <div className="bg-white w-full sm:max-w-2xl max-h-[100dvh] sm:max-h-[90vh] sm:rounded-2xl flex flex-col overflow-hidden">
                {/* Header */}
                <div className="border-b border-dd-line p-4 flex items-center justify-between safe-top">
                    <h2 className="text-lg font-bold text-dd-text">
                        📌 {tx('Required Tasks', 'Tareas Requeridas')}
                    </h2>
                    <button onClick={onClose}
                        className="text-dd-text-2 hover:text-dd-text text-2xl leading-none">×</button>
                </div>

                {/* Tabs */}
                <div className="border-b border-dd-line flex">
                    <button onClick={() => setView('compose')}
                        className={`flex-1 py-3 text-sm font-bold border-b-2 transition ${view === 'compose'
                            ? 'border-dd-green text-dd-green'
                            : 'border-transparent text-dd-text-2 hover:text-dd-text'}`}>
                        ➕ {tx('Push new', 'Enviar nuevo')}
                    </button>
                    <button onClick={() => setView('campaigns')}
                        className={`flex-1 py-3 text-sm font-bold border-b-2 transition ${view === 'campaigns'
                            ? 'border-dd-green text-dd-green'
                            : 'border-transparent text-dd-text-2 hover:text-dd-text'}`}>
                        📊 {tx('Campaigns', 'Campañas')}
                    </button>
                </div>

                {/* Body */}
                <div className="flex-1 overflow-y-auto p-4">
                    {view === 'compose' && (
                        <div className="space-y-4">
                            {/* Step 1 — pick type */}
                            <div>
                                <div className="text-[10px] font-bold uppercase tracking-wider text-dd-text-2 mb-2">
                                    1. {tx('Pick a task', 'Elige una tarea')}
                                </div>
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                    {TASK_TYPE_IDS.map(id => {
                                        const def = TASK_TYPES[id];
                                        const isSel = selectedType === id;
                                        return (
                                            <button key={id} onClick={() => setSelectedType(id)}
                                                className={`text-left p-3 rounded-xl border-2 transition ${isSel
                                                    ? 'border-dd-green bg-dd-green-50'
                                                    : 'border-dd-line bg-white hover:border-dd-text-2'}`}>
                                                <div className="flex items-start gap-2">
                                                    <span className="text-2xl flex-shrink-0">{def.icon}</span>
                                                    <div className="min-w-0">
                                                        <div className="text-sm font-bold text-dd-text">
                                                            {isEs ? def.labelEs : def.labelEn}
                                                        </div>
                                                        <div className="text-[11px] text-dd-text-2 mt-0.5 leading-snug">
                                                            {isEs ? def.descriptionEs : def.descriptionEn}
                                                        </div>
                                                    </div>
                                                </div>
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>

                            {/* Step 2 — pick recipients */}
                            <div>
                                <div className="text-[10px] font-bold uppercase tracking-wider text-dd-text-2 mb-2 flex items-center justify-between">
                                    <span>2. {tx('Pick recipients', 'Elige destinatarios')}</span>
                                    <span className="text-dd-green font-black">{selectedCount} {tx('selected', 'sel.')}</span>
                                </div>

                                {/* Quick filters */}
                                <div className="flex flex-wrap gap-1.5 mb-2">
                                    <select value={filterLocation} onChange={e => setFilterLocation(e.target.value)}
                                        className="text-xs border border-dd-line rounded-md px-2 py-1 bg-white">
                                        <option value="all">{tx('All locations', 'Todas')}</option>
                                        <option value="webster">Webster</option>
                                        <option value="maryland">MD Heights</option>
                                    </select>
                                    <select value={filterSide} onChange={e => setFilterSide(e.target.value)}
                                        className="text-xs border border-dd-line rounded-md px-2 py-1 bg-white">
                                        <option value="all">{tx('All sides', 'Todos lados')}</option>
                                        <option value="foh">FOH</option>
                                        <option value="boh">BOH</option>
                                    </select>
                                    <input type="text" value={search} onChange={e => setSearch(e.target.value)}
                                        placeholder={tx('Search name/role…', 'Buscar nombre/rol…')}
                                        className="flex-1 min-w-[120px] text-xs border border-dd-line rounded-md px-2 py-1 bg-white" />
                                </div>

                                {/* Shortcut buttons */}
                                <div className="flex flex-wrap gap-1.5 mb-2">
                                    <button onClick={selectAll}
                                        className="text-[11px] font-bold px-2.5 py-1 rounded-full bg-dd-text text-white hover:opacity-90">
                                        {tx(`Select all visible (${visibleStaff.length})`, `Todos visibles (${visibleStaff.length})`)}
                                    </button>
                                    <button onClick={selectStaffMissingThisTask}
                                        className="text-[11px] font-bold px-2.5 py-1 rounded-full bg-amber-100 text-amber-800 hover:bg-amber-200">
                                        ⚠ {tx('Only those who need it', 'Solo los que falta')}
                                    </button>
                                    {selectedCount > 0 && (
                                        <button onClick={clearSelection}
                                            className="text-[11px] font-bold px-2.5 py-1 rounded-full bg-white border border-dd-line text-dd-text-2 hover:bg-dd-bg">
                                            ✕ {tx('Clear', 'Limpiar')}
                                        </button>
                                    )}
                                </div>

                                {/* Recipient list */}
                                <div className="border border-dd-line rounded-lg max-h-64 overflow-y-auto">
                                    {visibleStaff.length === 0 ? (
                                        <div className="p-4 text-center text-xs text-dd-text-2">
                                            {tx('No matching staff', 'Sin coincidencias')}
                                        </div>
                                    ) : visibleStaff.map(s => {
                                        const checked = selectedIds.has(s.id);
                                        const typeDef = TASK_TYPES[selectedType];
                                        const wouldAutoResolve = typeDef?.autoComplete ? typeDef.autoComplete(s) : false;
                                        return (
                                            <label key={s.id}
                                                className={`flex items-center gap-2 px-3 py-2 border-b border-dd-line/50 last:border-b-0 cursor-pointer ${checked ? 'bg-dd-green-50' : 'hover:bg-dd-bg'}`}>
                                                <input type="checkbox" checked={checked}
                                                    onChange={() => toggleStaff(s.id)}
                                                    className="w-4 h-4 accent-dd-green" />
                                                <div className="flex-1 min-w-0">
                                                    <div className="text-sm font-bold text-dd-text truncate">{s.name}</div>
                                                    <div className="text-[10px] text-dd-text-2 truncate">
                                                        {s.role || ''} · {s.location || ''} · {(s.scheduleSide || 'foh').toUpperCase()}
                                                    </div>
                                                </div>
                                                {wouldAutoResolve && (
                                                    <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 border border-gray-200">
                                                        {tx('already done', 'ya hecho')}
                                                    </span>
                                                )}
                                            </label>
                                        );
                                    })}
                                </div>
                            </div>

                            {/* Step 3 — options */}
                            <div>
                                <div className="text-[10px] font-bold uppercase tracking-wider text-dd-text-2 mb-2">
                                    3. {tx('Options', 'Opciones')}
                                </div>
                                <div className="space-y-2">
                                    <label className="flex items-start gap-2 cursor-pointer">
                                        <input type="checkbox" checked={blockApp} onChange={e => setBlockApp(e.target.checked)}
                                            className="mt-1 w-4 h-4 accent-dd-green" />
                                        <div>
                                            <div className="text-sm font-bold text-dd-text">
                                                {tx('Block app until completed', 'Bloquear app hasta completar')}
                                            </div>
                                            <div className="text-[11px] text-dd-text-2">
                                                {tx(
                                                    'Hard gate: staff sees this on next login and cannot reach Chat/Schedule until they answer.',
                                                    'Bloqueo: el staff verá esto al iniciar y no podrá usar Chat/Horario hasta responder.',
                                                )}
                                            </div>
                                        </div>
                                    </label>
                                    <label className="flex items-start gap-2 cursor-pointer">
                                        <input type="checkbox" checked={allowSkip} onChange={e => setAllowSkip(e.target.checked)}
                                            className="mt-1 w-4 h-4 accent-dd-green" />
                                        <div>
                                            <div className="text-sm font-bold text-dd-text">
                                                {tx('Allow "skip for now"', 'Permitir "saltar por ahora"')}
                                            </div>
                                            <div className="text-[11px] text-dd-text-2">
                                                {tx(
                                                    'Staff can defer. Task stays pending; they see it again next login.',
                                                    'El staff puede aplazar. La tarea queda pendiente; reaparece al iniciar.',
                                                )}
                                            </div>
                                        </div>
                                    </label>
                                </div>
                            </div>

                            {/* Step 4 — push */}
                            <button onClick={handlePush}
                                disabled={pushing || selectedCount === 0}
                                className="w-full py-3 rounded-xl bg-dd-green text-white font-black text-base active:scale-95 transition disabled:opacity-50 disabled:cursor-not-allowed">
                                {pushing
                                    ? tx('Pushing…', 'Enviando…')
                                    : tx(`Push to ${selectedCount} staff`, `Enviar a ${selectedCount}`)}
                            </button>
                        </div>
                    )}

                    {view === 'campaigns' && (
                        <div className="space-y-2">
                            {campaigns.length === 0 ? (
                                <div className="text-center text-sm text-dd-text-2 py-8">
                                    {tx('No campaigns yet. Push one from the other tab.', 'Sin campañas. Envía una desde la otra pestaña.')}
                                </div>
                            ) : campaigns.map(c => {
                                const expanded = expandedCampaign === c.campaignId;
                                const total = c.tasks.length;
                                const def = TASK_TYPES[c.taskType];
                                const at = c.createdAt?.toDate?.() ?? null;
                                return (
                                    <div key={c.campaignId} className="border border-dd-line rounded-lg overflow-hidden">
                                        <button onClick={() => setExpandedCampaign(expanded ? null : c.campaignId)}
                                            className="w-full p-3 text-left hover:bg-dd-bg flex items-center gap-3">
                                            <span className="text-2xl flex-shrink-0">{def?.icon || '📌'}</span>
                                            <div className="flex-1 min-w-0">
                                                <div className="text-sm font-bold text-dd-text">
                                                    {def ? (isEs ? def.labelEs : def.labelEn) : c.taskType}
                                                </div>
                                                <div className="text-[11px] text-dd-text-2">
                                                    {at ? at.toLocaleString(isEs ? 'es' : 'en', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'}
                                                    {' · '}
                                                    {tx(`by ${c.createdBy}`, `por ${c.createdBy}`)}
                                                </div>
                                            </div>
                                            <div className="flex flex-col items-end gap-0.5 flex-shrink-0">
                                                <div className="text-sm font-black text-dd-green">{c.completed}/{total}</div>
                                                <div className="text-[9px] text-dd-text-2">{tx('done', 'completos')}</div>
                                            </div>
                                        </button>
                                        {expanded && (
                                            <div className="border-t border-dd-line/50 p-3 bg-dd-bg/50">
                                                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3 text-center">
                                                    <Stat label={tx('Pending', 'Pendiente')} value={c.pending} tone="amber" />
                                                    <Stat label={tx('Done', 'Completos')} value={c.completed} tone="green" />
                                                    <Stat label={tx('Skipped', 'Saltados')} value={c.skipped} tone="gray" />
                                                    <Stat label={tx('Cancelled', 'Cancelados')} value={c.cancelled} tone="gray" />
                                                </div>
                                                <div className="text-[10px] font-bold uppercase tracking-wider text-dd-text-2 mb-1">
                                                    {tx('Recipients', 'Destinatarios')}
                                                </div>
                                                <div className="max-h-48 overflow-y-auto bg-white border border-dd-line rounded-md">
                                                    {c.tasks.map(t => (
                                                        <div key={t.id} className="flex items-center justify-between px-2 py-1.5 border-b border-dd-line/30 last:border-b-0 text-xs">
                                                            <span className="font-bold text-dd-text">{t.forStaff}</span>
                                                            <div className="flex items-center gap-2">
                                                                <span className={`font-bold ${
                                                                    t.status === TASK_STATUS.COMPLETED ? 'text-green-700'
                                                                    : t.status === TASK_STATUS.PENDING ? 'text-amber-700'
                                                                    : t.status === TASK_STATUS.SKIPPED ? 'text-gray-500'
                                                                    : 'text-gray-400'
                                                                }`}>
                                                                    {t.status === TASK_STATUS.COMPLETED && '✓'}
                                                                    {t.status === TASK_STATUS.PENDING && '⏳'}
                                                                    {t.status === TASK_STATUS.SKIPPED && '↪'}
                                                                    {t.status === TASK_STATUS.CANCELLED && '✕'}
                                                                    {' '}{t.status}
                                                                </span>
                                                                {t.status === TASK_STATUS.PENDING && (
                                                                    <button onClick={async () => {
                                                                        if (confirm(tx(`Cancel for ${t.forStaff}?`, `¿Cancelar para ${t.forStaff}?`))) {
                                                                            await cancelTask(t.id, { byName: staffName || 'admin' });
                                                                        }
                                                                    }}
                                                                        className="text-[10px] px-1.5 py-0.5 rounded bg-red-50 text-red-700 hover:bg-red-100 border border-red-200">
                                                                        ✕
                                                                    </button>
                                                                )}
                                                            </div>
                                                        </div>
                                                    ))}
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
            </div>
        </div>
        </ModalPortal>
    );
}

function Stat({ label, value, tone }) {
    const cls = tone === 'green' ? 'bg-green-50 text-green-700 border-green-200'
        : tone === 'amber' ? 'bg-amber-50 text-amber-700 border-amber-200'
        : 'bg-gray-50 text-gray-600 border-gray-200';
    return (
        <div className={`rounded-md border ${cls} py-1`}>
            <div className="text-lg font-black">{value}</div>
            <div className="text-[9px] font-bold uppercase tracking-wider">{label}</div>
        </div>
    );
}
