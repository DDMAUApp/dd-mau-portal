// NotificationsAdmin — admin-only page for picking who gets which
// optional push notifications.
//
// Andrew 2026-05-24 (v2) — "the notification preferences page need to
// be easier to edit everyone maybe a toggle on each line."
//
// Pivot from per-staff modal (v1) to TYPE-FIRST inline expand. The
// dominant use case is "for THIS notification, pick the people" — not
// "for THIS person, pick the notifications". So:
//   • Page lists every notification type grouped by category
//   • Each row shows "X of N receiving" + an expand chevron
//   • Tap a row → inline staff list with iOS-style toggle switches
//   • Bulk chips per type: All on · All off · Just managers · Just admins
//   • Save commits a single Firestore transaction (one batch write)
//
// Locked-on types (chat / personal schedule / your own tasks) render
// as 🔒 rows with NO toggles — they're always-on regardless of state.
// They stay in the list (read-only) so admin can see the full picture.
//
// Data model unchanged from v1: pushOptOut: string[] on each
// /config/staff.list[] entry. v1 modal lived per-staff; v2 lives per-
// type but writes to the same field via applyOptOutBulk in
// data/notificationTypes.js.

import { useState, useMemo } from 'react';
import { db } from '../firebase';
import { doc, runTransaction } from 'firebase/firestore';
import { toast } from '../toast';
import {
    NOTIFICATION_CATEGORIES,
    NOTIFICATION_TYPES,
    LOCKED_ON_TYPE_IDS,
    OWNER_ONLY_TYPE_IDS,
    getRecipientNames,
    applyOptOutBulk,
} from '../data/notificationTypes';

export default function NotificationsAdmin({
    language = 'en',
    staffName,
    staffList,
    setStaffList,
}) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);
    const [expandedTypeId, setExpandedTypeId] = useState(null);
    const [filter, setFilter] = useState('');

    // Group types by category. Order matters — render in category order.
    const groupedTypes = useMemo(() => {
        const byCategory = {};
        for (const t of NOTIFICATION_TYPES) {
            if (!byCategory[t.category]) byCategory[t.category] = [];
            byCategory[t.category].push(t);
        }
        const q = filter.trim().toLowerCase();
        return NOTIFICATION_CATEGORIES
            .map((c) => ({
                ...c,
                types: (byCategory[c.id] || []).filter((t) =>
                    !q
                    || (tx(t.en, t.es) || '').toLowerCase().includes(q)
                    || t.id.toLowerCase().includes(q)
                ),
            }))
            .filter((g) => g.types.length > 0);
    }, [filter, isEs]);

    return (
        <section className="w-full max-w-3xl mx-auto px-3 md:px-6 py-4 md:py-6 space-y-4">
            <header>
                <h1 className="text-2xl md:text-3xl font-black text-dd-text tracking-tight">
                    🔔 {tx('Notification preferences', 'Preferencias de notificaciones')}
                </h1>
                <p className="text-[12.5px] text-dd-text-2 mt-1 max-w-2xl">
                    {tx(
                        'Pick who receives each push notification type. Tap a type to expand. Chat + personal schedule changes are always pushed (locked).',
                        'Elige quién recibe cada tipo de notificación. Toca un tipo para expandir. Chat y cambios personales de horario siempre se envían (bloqueado).',
                    )}
                </p>
            </header>

            <input
                type="search"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder={tx('Search notification type…', 'Buscar tipo…')}
                className="w-full px-4 py-2.5 rounded-xl bg-white border border-dd-line text-base focus:outline-none focus:ring-2 focus:ring-dd-green/30 focus:border-dd-green"
            />

            <div className="space-y-3">
                {groupedTypes.map((group) => (
                    <div key={group.id} className="bg-white border border-dd-line rounded-2xl overflow-hidden">
                        <div className="px-4 py-2 bg-dd-bg/60 border-b border-dd-line">
                            <h2 className="text-xs font-black uppercase tracking-widest text-dd-text">
                                {tx(group.en, group.es)}
                            </h2>
                        </div>
                        <div className="divide-y divide-dd-line/60">
                            {group.types.map((t) => (
                                <TypeRow
                                    key={t.id}
                                    type={t}
                                    expanded={expandedTypeId === t.id}
                                    onToggleExpand={() => setExpandedTypeId((prev) => (prev === t.id ? null : t.id))}
                                    staffList={staffList}
                                    setStaffList={setStaffList}
                                    actorName={staffName}
                                    language={language}
                                />
                            ))}
                        </div>
                    </div>
                ))}
                {groupedTypes.length === 0 && (
                    <div className="p-8 text-center text-sm text-dd-text-2 bg-white border border-dd-line rounded-2xl">
                        {tx('No types match that search.', 'Sin coincidencias.')}
                    </div>
                )}
            </div>
        </section>
    );
}

function TypeRow({ type, expanded, onToggleExpand, staffList, setStaffList, actorName, language }) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);
    const locked = LOCKED_ON_TYPE_IDS.has(type.id);
    // Owner-only types behave like locked types in this UI — no per-staff
    // toggle picker, can't be muted, can't be redirected. They render with
    // a distinct "owners only" label so it's clear who actually gets them.
    const ownerOnly = OWNER_ONLY_TYPE_IDS.has(type.id);

    // Active staff = candidates we render toggles for. Skipping
    // active === false keeps deactivated rows out of the picker.
    const activeStaff = useMemo(() => {
        const list = Array.isArray(staffList) ? staffList : [];
        return list
            .filter((s) => s && s.name && s.active !== false)
            .sort((a, b) => a.name.localeCompare(b.name));
    }, [staffList]);

    // Committed (server) recipient set — used for the badge and for
    // diffing against the working set on save.
    const committedReceivers = useMemo(
        () => new Set(getRecipientNames(type.id, staffList)),
        [type.id, staffList]
    );
    const receivingCount = committedReceivers.size;
    const totalCount = activeStaff.length;

    return (
        <div>
            <button
                type="button"
                onClick={onToggleExpand}
                className="w-full flex items-center gap-3 px-4 py-3 hover:bg-dd-bg/50 text-left transition"
            >
                <div className="flex-1 min-w-0">
                    <div className="text-sm font-bold text-dd-text leading-tight">
                        {tx(type.en, type.es)}
                        {locked && (
                            <span className="ml-2 text-[10px] uppercase font-black text-dd-text-2 align-middle">
                                🔒 {tx('always on', 'siempre activo')}
                            </span>
                        )}
                        {ownerOnly && (
                            <span className="ml-2 text-[10px] uppercase font-black text-amber-700 align-middle">
                                👑 {tx('owners only', 'solo dueños')}
                            </span>
                        )}
                    </div>
                    <div className="text-[11px] text-dd-text-2 mt-0.5">
                        {ownerOnly
                            ? `${receivingCount} ${tx('owner(s) only — cannot be shared', 'dueño(s) solamente — no se puede compartir')}`
                            : locked
                                ? `${totalCount} ${tx('recipients (cannot mute)', 'destinatarios (no se puede silenciar)')}`
                                : `${receivingCount} ${tx('of', 'de')} ${totalCount} ${tx('receiving', 'reciben')}`}
                    </div>
                </div>
                {!locked && !ownerOnly && (
                    <span className={`text-dd-text-2 text-base shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`}>
                        ▾
                    </span>
                )}
            </button>
            {expanded && !locked && !ownerOnly && (
                <ExpandedRecipientPicker
                    type={type}
                    activeStaff={activeStaff}
                    committedReceivers={committedReceivers}
                    setStaffList={setStaffList}
                    actorName={actorName}
                    language={language}
                    onClose={onToggleExpand}
                />
            )}
        </div>
    );
}

function ExpandedRecipientPicker({ type, activeStaff, committedReceivers, setStaffList, actorName, language, onClose }) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);

    // Local working set of "who receives this type". Initialized from
    // the committed server state. Save commits the diff to Firestore.
    const [receivers, setReceivers] = useState(() => new Set(committedReceivers));
    const [saving, setSaving] = useState(false);

    const toggleStaff = (name) => {
        setReceivers((prev) => {
            const next = new Set(prev);
            if (next.has(name)) next.delete(name);
            else next.add(name);
            return next;
        });
    };

    const setAllOn = () => setReceivers(new Set(activeStaff.map((s) => s.name)));
    const setAllOff = () => setReceivers(new Set());
    const setJustManagers = () => {
        const names = activeStaff
            .filter((s) => s.id === 40 || s.id === 41 || /manager|owner/i.test(s.role || ''))
            .map((s) => s.name);
        setReceivers(new Set(names));
    };
    const setJustAdmins = () => {
        const names = activeStaff.filter((s) => s.id === 40 || s.id === 41).map((s) => s.name);
        setReceivers(new Set(names));
    };

    const dirty = useMemo(() => {
        if (receivers.size !== committedReceivers.size) return true;
        for (const n of receivers) if (!committedReceivers.has(n)) return true;
        return false;
    }, [receivers, committedReceivers]);

    const handleSave = async () => {
        if (saving || !dirty) return;
        setSaving(true);
        try {
            await runTransaction(db, async (txn) => {
                const ref = doc(db, 'config', 'staff');
                const snap = await txn.get(ref);
                if (!snap.exists()) throw new Error('staff doc missing');
                const liveList = (snap.data() || {}).list || [];
                const nextList = applyOptOutBulk(liveList, type.id, Array.from(receivers));
                txn.set(ref, { list: nextList });
            });
            // Mirror locally so the "X of N" badge updates without
            // waiting for the snapshot listener to catch up.
            if (setStaffList) {
                setStaffList((prev) => applyOptOutBulk(prev, type.id, Array.from(receivers)));
            }
            toast(tx('Saved', 'Guardado'), { kind: 'success' });
            onClose?.();
        } catch (e) {
            console.error('NotificationsAdmin save failed:', e);
            toast(tx('Save failed: ', 'Error al guardar: ') + (e.message || 'unknown'), { kind: 'error' });
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="border-t border-dd-line bg-dd-bg/30">
            {/* Bulk quick-action chips */}
            <div className="flex flex-wrap gap-1.5 px-4 py-2 border-b border-dd-line/60">
                <BulkChip label={tx('All on', 'Activar todas')} onClick={setAllOn} />
                <BulkChip label={tx('All off', 'Desactivar todas')} onClick={setAllOff} />
                <BulkChip label={tx('Just managers', 'Solo gerentes')} onClick={setJustManagers} />
                <BulkChip label={tx('Just admins', 'Solo admins')} onClick={setJustAdmins} />
            </div>

            {/* Per-staff toggle list */}
            <div className="divide-y divide-dd-line/40 max-h-[55vh] overflow-y-auto">
                {activeStaff.map((staff) => {
                    const on = receivers.has(staff.name);
                    const initials = (staff.name.split(' ').map((p) => p[0]).slice(0, 2).join('') || '?').toUpperCase();
                    return (
                        <label
                            key={staff.id ?? staff.name}
                            className="flex items-center gap-3 px-4 py-2.5 hover:bg-white cursor-pointer"
                        >
                            <div className={`w-9 h-9 rounded-full flex items-center justify-center text-[12px] font-black shrink-0 ${on ? 'bg-dd-green text-white' : 'bg-dd-bg text-dd-text-2'}`}>
                                {initials}
                            </div>
                            <div className="flex-1 min-w-0">
                                <div className="text-sm font-bold text-dd-text truncate">{staff.name}</div>
                                {staff.role && (
                                    <div className="text-[10.5px] text-dd-text-2 uppercase tracking-wider">{staff.role}</div>
                                )}
                            </div>
                            <ToggleSwitch checked={on} onChange={() => toggleStaff(staff.name)} />
                        </label>
                    );
                })}
            </div>

            {/* Footer */}
            <div className="px-4 py-3 border-t border-dd-line flex items-center gap-2 bg-white sticky bottom-0">
                <span className="text-[11.5px] text-dd-text-2 flex-1">
                    {receivers.size === 0
                        ? tx('No one will receive this', 'Nadie recibirá esto')
                        : `${receivers.size} ${receivers.size === 1 ? tx('person', 'persona') : tx('people', 'personas')}`}
                </span>
                <button
                    onClick={onClose}
                    disabled={saving}
                    className="px-3 py-1.5 rounded-lg border border-dd-line text-sm font-bold text-dd-text-2 hover:bg-dd-bg"
                >
                    {tx('Cancel', 'Cancelar')}
                </button>
                <button
                    onClick={handleSave}
                    disabled={saving || !dirty}
                    className="px-4 py-1.5 rounded-lg bg-dd-green text-white text-sm font-bold hover:bg-dd-green-700 disabled:opacity-60"
                >
                    {saving ? tx('Saving…', 'Guardando…') : tx('Save', 'Guardar')}
                </button>
            </div>
        </div>
    );
}

function BulkChip({ label, onClick }) {
    return (
        <button
            type="button"
            onClick={onClick}
            className="px-2.5 py-1 rounded-full bg-white border border-dd-line text-[11px] font-bold text-dd-text-2 hover:bg-dd-sage-50 hover:text-dd-green-700 active:scale-95 transition"
        >
            {label}
        </button>
    );
}

// iOS-style toggle switch. Bigger tap target than a checkbox + obvious
// on/off state at a glance. Pure CSS — no library dep.
function ToggleSwitch({ checked, onChange }) {
    return (
        <button
            type="button"
            role="switch"
            aria-checked={checked}
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onChange?.(); }}
            className={`relative inline-flex h-7 w-12 shrink-0 rounded-full transition-colors duration-150 ${checked ? 'bg-dd-green' : 'bg-dd-line'}`}
        >
            <span
                className={`absolute top-0.5 inline-block h-6 w-6 rounded-full bg-white shadow-sm transition-transform duration-150 ${checked ? 'translate-x-[1.375rem]' : 'translate-x-0.5'}`}
            />
        </button>
    );
}
