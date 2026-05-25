// NotificationsAdmin — admin-only page for picking who gets which
// optional push notifications.
//
// Andrew 2026-05-24 — "i want to add a notification page in admin where
// i can add who get what notifications because some people get
// notifications they shouldnt." Example given: TV alerts should only go
// to a few people the admin picks.
//
// Data model:
//   • New field `pushOptOut: string[]` on each /config/staff.list[]
//     entry. Default empty = receives everything.
//   • Server: dispatchNotification + dispatchSms check this array AND
//     the LOCKED_ON_TYPE_IDS set — locked-on types (chat, your own
//     schedule, your own tasks) are pushed regardless of opt-out state.
//
// Page structure:
//   • One row per staff. Tap row → modal with all notification types
//     grouped by category. Locked types render as 🔒 read-only.
//     Toggleable types render as checkboxes.
//   • Per-category "Mute all / Unmute all" affordance.
//   • "Reset" button restores receive-all.
//   • Save uses a runTransaction on /config/staff to avoid the
//     concurrent-edit clobber pattern we already burned on in
//     saveStaffToFirestore (round 3 audit).

import { useState, useMemo } from 'react';
import { db } from '../firebase';
import { doc, runTransaction } from 'firebase/firestore';
import { toast } from '../toast';
import {
    NOTIFICATION_CATEGORIES,
    NOTIFICATION_TYPES,
    OPT_OUT_ABLE_TYPES,
} from '../data/notificationTypes';

export default function NotificationsAdmin({
    language = 'en',
    staffName,
    staffList,
    setStaffList,
}) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);
    const [editingStaff, setEditingStaff] = useState(null);
    const [filter, setFilter] = useState('');

    // Sort staff alphabetically; admin can scan + search by name.
    // Filter excludes anyone without a name (defensive against
    // half-edited legacy rows).
    const sortedStaff = useMemo(() => {
        const q = filter.trim().toLowerCase();
        return [...(staffList || [])]
            .filter((s) => s && s.name)
            .filter((s) => !q
                || s.name.toLowerCase().includes(q)
                || (s.role || '').toLowerCase().includes(q))
            .sort((a, b) => a.name.localeCompare(b.name));
    }, [staffList, filter]);

    return (
        <section className="w-full max-w-4xl mx-auto px-3 md:px-6 py-4 md:py-6 space-y-4">
            <header>
                <h1 className="text-2xl md:text-3xl font-black text-dd-text tracking-tight">
                    🔔 {tx('Notification preferences', 'Preferencias de notificaciones')}
                </h1>
                <p className="text-[12.5px] text-dd-text-2 mt-1 max-w-2xl">
                    {tx(
                        'Pick which staff get which optional push notifications. Chat + personal schedule changes always push (locked). Tap any row to edit.',
                        'Elige quién recibe qué notificaciones opcionales. Chat y cambios en tu horario personal siempre se envían (bloqueado). Toca una fila para editar.',
                    )}
                </p>
            </header>

            {/* Search — quick way to find a specific staffer in a 30+ row list. */}
            <input
                type="search"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder={tx('Search staff name or role…', 'Buscar nombre o rol…')}
                className="w-full px-4 py-2.5 rounded-xl bg-white border border-dd-line text-base focus:outline-none focus:ring-2 focus:ring-dd-green/30 focus:border-dd-green"
            />

            <div className="bg-white border border-dd-line rounded-2xl overflow-hidden divide-y divide-dd-line">
                {sortedStaff.length === 0 ? (
                    <div className="p-8 text-center text-sm text-dd-text-2">
                        {tx('No staff match that search.', 'Sin coincidencias.')}
                    </div>
                ) : (
                    sortedStaff.map((staff) => {
                        const optOuts = Array.isArray(staff.pushOptOut) ? staff.pushOptOut : [];
                        const totalOptable = OPT_OUT_ABLE_TYPES.length;
                        const mutedCount = optOuts.filter((id) => OPT_OUT_ABLE_TYPES.some((t) => t.id === id)).length;
                        return (
                            <button
                                key={staff.id}
                                onClick={() => setEditingStaff(staff)}
                                className="w-full flex items-center gap-3 px-4 py-3 hover:bg-dd-bg text-left transition"
                            >
                                <div className="w-10 h-10 rounded-full bg-dd-sage-50 flex items-center justify-center text-sm font-black text-dd-green-700 shrink-0">
                                    {(staff.name.split(' ').map((p) => p[0]).slice(0, 2).join('') || '?').toUpperCase()}
                                </div>
                                <div className="flex-1 min-w-0">
                                    <div className="text-sm font-bold text-dd-text truncate">
                                        {staff.name}
                                        {staff.role && (
                                            <span className="ml-2 text-[10.5px] font-bold text-dd-text-2 uppercase tracking-wider">
                                                {staff.role}
                                            </span>
                                        )}
                                    </div>
                                    <div className="text-[11.5px] text-dd-text-2 mt-0.5">
                                        {mutedCount === 0
                                            ? `✓ ${tx('All optional alerts on', 'Todas las alertas activas')}`
                                            : `🔕 ${mutedCount} / ${totalOptable} ${tx('muted', 'silenciadas')}`}
                                    </div>
                                </div>
                                <span className="text-dd-text-2 text-xs shrink-0">{tx('Edit →', 'Editar →')}</span>
                            </button>
                        );
                    })
                )}
            </div>

            {editingStaff && (
                <NotificationEditModal
                    staff={editingStaff}
                    setStaffList={setStaffList}
                    actorName={staffName}
                    language={language}
                    onClose={() => setEditingStaff(null)}
                />
            )}
        </section>
    );
}

function NotificationEditModal({ staff, setStaffList, actorName, language, onClose }) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);
    // Local working set — Set<typeId> of muted types.
    const [optOuts, setOptOuts] = useState(
        () => new Set(Array.isArray(staff.pushOptOut) ? staff.pushOptOut : [])
    );
    const [saving, setSaving] = useState(false);

    const toggleType = (typeId) => {
        if (!typeId) return;
        setOptOuts((prev) => {
            const next = new Set(prev);
            if (next.has(typeId)) next.delete(typeId);
            else next.add(typeId);
            return next;
        });
    };

    const toggleCategory = (categoryId) => {
        const ids = OPT_OUT_ABLE_TYPES.filter((t) => t.category === categoryId).map((t) => t.id);
        if (ids.length === 0) return;
        const allMuted = ids.every((id) => optOuts.has(id));
        setOptOuts((prev) => {
            const next = new Set(prev);
            for (const id of ids) {
                if (allMuted) next.delete(id);
                else next.add(id);
            }
            return next;
        });
    };

    const handleReset = () => {
        if (!window.confirm(tx(
            `Reset ${staff.name} to receive ALL optional notifications?`,
            `¿Restablecer ${staff.name} para recibir TODAS las notificaciones opcionales?`,
        ))) return;
        setOptOuts(new Set());
    };

    const handleSave = async () => {
        if (saving) return;
        setSaving(true);
        try {
            // 2026-05-24: runTransaction reads + writes /config/staff
            // atomically so this doesn't clobber another admin's
            // concurrent edit (same bug class as the 2026-05-09 PIN-
            // wipe incident; the audit-round-3 dispatchNotification
            // CF fix uses the same pattern).
            const newOptOuts = Array.from(optOuts).sort();
            await runTransaction(db, async (txn) => {
                const ref = doc(db, 'config', 'staff');
                const snap = await txn.get(ref);
                if (!snap.exists()) throw new Error('staff doc missing');
                const list = (snap.data() || {}).list || [];
                const idx = list.findIndex((s) => s.id === staff.id);
                if (idx === -1) throw new Error('staff record not found');
                const nextList = list.map((s, i) =>
                    i === idx ? { ...s, pushOptOut: newOptOuts } : s
                );
                txn.set(ref, { list: nextList });
            });
            // Mirror to local React state so the row's "X muted" count
            // refreshes immediately without waiting for the snapshot.
            if (setStaffList) {
                setStaffList((prev) => prev.map((s) =>
                    s.id === staff.id ? { ...s, pushOptOut: newOptOuts } : s
                ));
            }
            toast(tx('Saved', 'Guardado'), { kind: 'success' });
            onClose();
        } catch (e) {
            console.error('Save failed:', e);
            toast(tx('Save failed: ', 'Error al guardar: ') + (e.message || 'unknown'), { kind: 'error' });
        } finally {
            setSaving(false);
        }
    };

    // Group types for rendering — preserve category order.
    const grouped = useMemo(() => {
        const byId = {};
        for (const t of NOTIFICATION_TYPES) {
            if (!byId[t.category]) byId[t.category] = [];
            byId[t.category].push(t);
        }
        return NOTIFICATION_CATEGORIES
            .map((c) => ({ ...c, types: byId[c.id] || [] }))
            .filter((g) => g.types.length > 0);
    }, []);

    return (
        <div
            className="fixed inset-0 z-50 bg-black/50 flex items-end md:items-center justify-center"
            onClick={onClose}
        >
            <div
                className="bg-white w-full md:max-w-2xl md:rounded-2xl rounded-t-2xl flex flex-col max-h-[90vh] shadow-xl"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="px-5 py-4 border-b border-dd-line flex items-center justify-between shrink-0">
                    <div className="min-w-0">
                        <h2 className="text-lg font-black text-dd-text truncate">{staff.name}</h2>
                        <p className="text-[11.5px] text-dd-text-2 truncate">
                            {staff.role || '—'} · {tx('push notifications', 'notificaciones push')}
                        </p>
                    </div>
                    <button
                        onClick={onClose}
                        className="w-9 h-9 rounded-full hover:bg-dd-bg text-dd-text-2 flex items-center justify-center shrink-0"
                        aria-label={tx('Close', 'Cerrar')}
                    >
                        ✕
                    </button>
                </div>

                <div className="flex-1 overflow-y-auto p-3 space-y-3">
                    {grouped.map((group) => {
                        const optableInGroup = group.types.filter((t) => !t.lockedOn);
                        const allMuted = optableInGroup.length > 0
                            && optableInGroup.every((t) => optOuts.has(t.id));
                        return (
                            <div key={group.id} className="bg-dd-bg/40 border border-dd-line rounded-xl overflow-hidden">
                                <div className="px-3 py-2 flex items-center justify-between bg-white border-b border-dd-line">
                                    <div className="text-xs font-black uppercase tracking-wider text-dd-text">
                                        {tx(group.en, group.es)}
                                    </div>
                                    {optableInGroup.length > 0 && (
                                        <button
                                            type="button"
                                            onClick={() => toggleCategory(group.id)}
                                            className="text-[10.5px] font-bold text-dd-green-700 hover:underline"
                                        >
                                            {allMuted ? tx('Turn all on', 'Activar todas') : tx('Mute all', 'Silenciar todas')}
                                        </button>
                                    )}
                                </div>
                                <div className="divide-y divide-dd-line/50">
                                    {group.types.map((t) => {
                                        const muted = optOuts.has(t.id);
                                        const locked = t.lockedOn;
                                        const on = locked || !muted;
                                        return (
                                            <label
                                                key={t.id}
                                                className={`flex items-center gap-3 px-3 py-2.5 ${locked ? 'opacity-70 cursor-not-allowed' : 'cursor-pointer hover:bg-white'}`}
                                            >
                                                <input
                                                    type="checkbox"
                                                    checked={on}
                                                    disabled={locked}
                                                    onChange={() => toggleType(t.id)}
                                                    className="w-5 h-5 accent-dd-green shrink-0"
                                                />
                                                <div className="flex-1 min-w-0">
                                                    <div className="text-sm font-bold text-dd-text leading-tight">
                                                        {tx(t.en, t.es)}
                                                        {locked && (
                                                            <span className="ml-2 text-[10px] uppercase font-black text-dd-text-2 align-middle">
                                                                🔒 {tx('locked on', 'siempre activo')}
                                                            </span>
                                                        )}
                                                    </div>
                                                </div>
                                            </label>
                                        );
                                    })}
                                </div>
                            </div>
                        );
                    })}

                    <p className="text-[11px] text-dd-text-2 italic px-2 pb-2">
                        {tx(
                            'Muted notifications still appear in the bell drawer — only the phone push is suppressed.',
                            'Las notificaciones silenciadas siguen apareciendo en la campana — solo se suprime el push del teléfono.',
                        )}
                    </p>
                </div>

                <div className="px-4 py-3 border-t border-dd-line flex items-center gap-2 shrink-0 bg-white">
                    <button
                        onClick={handleReset}
                        disabled={saving}
                        className="text-xs font-bold text-dd-text-2 hover:underline disabled:opacity-50"
                    >
                        {tx('Reset (all on)', 'Restablecer')}
                    </button>
                    <span className="flex-1" />
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
                        className="px-4 py-2 rounded-lg bg-dd-green text-white text-sm font-bold hover:bg-dd-green-700 disabled:opacity-60"
                    >
                        {saving ? tx('Saving…', 'Guardando…') : tx('Save', 'Guardar')}
                    </button>
                </div>
            </div>
        </div>
    );
}
