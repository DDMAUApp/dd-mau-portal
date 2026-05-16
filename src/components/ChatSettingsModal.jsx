// ChatSettingsModal — view/edit group + channel + DM details.
//
// Permission gates:
//   • view-only mode if !canEditChat (anyone can SEE members, name, etc.)
//   • edit mode allows: rename, change emoji, add/remove members,
//     promote/demote co-admins, delete group
//   • channels: even when canEdit (app admin), member list is auto-
//     synced from staff list, so add/remove is disabled. Admins CAN
//     rename + re-emoji a channel.
//   • DMs: nothing is editable; modal shows "members" only.
//
// Delete group is a hard delete of the chat doc + a soft-clear of
// members (we DON'T cascade-delete /messages — those stick around so
// the audit trail is preserved; the chat just disappears from
// everyone's list because members array is empty). The Cloud Function
// (TODO) can do a true purge on a delay if we ever want it.

import { useState, useMemo } from 'react';
import { db } from '../firebase';
import { doc, deleteDoc, updateDoc, serverTimestamp } from 'firebase/firestore';
import { canEditChat } from '../data/chat';
import { ChatAvatar, chatDisplayName } from './ChatCenter';

export default function ChatSettingsModal({
    chat, language, staffName, staffList, isAdmin, viewer, onClose, onDeleted,
}) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);
    const canEdit = canEditChat(chat, viewer, isAdmin);
    const isChannel = chat.type === 'channel';
    const isDm = chat.type === 'dm';

    const [name, setName] = useState(chat.name || '');
    const [emoji, setEmoji] = useState(chat.emoji || '💬');
    const [members, setMembers] = useState(Array.isArray(chat.members) ? chat.members : []);
    const [coAdmins, setCoAdmins] = useState(Array.isArray(chat.admins) ? chat.admins : []);
    const [showAdd, setShowAdd] = useState(false);
    const [busy, setBusy] = useState(false);

    const addable = useMemo(() => {
        return (staffList || [])
            .filter(s => s.name && !members.includes(s.name))
            .filter(s => s.hideFromSchedule !== true)
            .sort((a, b) => a.name.localeCompare(b.name));
    }, [staffList, members]);

    async function handleSave() {
        if (!canEdit || isDm || busy) return;
        setBusy(true);
        try {
            const patch = {};
            if (name.trim() && name.trim() !== chat.name) patch.name = name.trim().slice(0, 60);
            if (emoji && emoji !== chat.emoji) patch.emoji = emoji;
            // Channels: never overwrite members from this modal.
            if (!isChannel) {
                patch.members = Array.from(new Set([chat.createdBy, ...members].filter(Boolean)));
                patch.admins = coAdmins.filter(n => patch.members.includes(n));
            }
            if (Object.keys(patch).length > 0) {
                await updateDoc(doc(db, 'chats', chat.id), patch);
            }
            onClose();
        } catch (e) {
            console.warn('chat update failed:', e);
            alert(tx('Save failed', 'Error al guardar'));
        } finally {
            setBusy(false);
        }
    }

    async function handleLeave() {
        if (busy) return;
        const ok = window.confirm(tx(
            'Leave this chat? You will stop getting notifications.',
            '¿Salir de este chat? Dejarás de recibir notificaciones.'
        ));
        if (!ok) return;
        setBusy(true);
        try {
            await updateDoc(doc(db, 'chats', chat.id), {
                members: (chat.members || []).filter(n => n !== staffName),
                admins: (chat.admins || []).filter(n => n !== staffName),
            });
            onDeleted();
        } catch (e) {
            console.warn('leave failed:', e);
        } finally {
            setBusy(false);
        }
    }

    async function handleDelete() {
        if (!canEdit || isDm || isChannel || busy) return;
        const ok = window.confirm(tx(
            'Delete this group? Messages stay in the audit log but the group disappears for everyone.',
            '¿Eliminar este grupo? Los mensajes permanecen en el log pero el grupo desaparece para todos.'
        ));
        if (!ok) return;
        setBusy(true);
        try {
            // Soft delete: clear members → vanishes from every list.
            // We don't deleteDoc immediately so we keep a stub for any
            // audit references (mentioned link in notifications, etc.).
            await updateDoc(doc(db, 'chats', chat.id), {
                members: [],
                deletedAt: serverTimestamp(),
                deletedBy: staffName,
            });
            onDeleted();
        } catch (e) {
            console.warn('delete failed:', e);
            alert(tx('Delete failed', 'Error al eliminar'));
        } finally {
            setBusy(false);
        }
    }

    function toggleMember(n) {
        setMembers(prev => prev.includes(n) ? prev.filter(x => x !== n) : [...prev, n]);
    }

    function toggleCoAdmin(n) {
        if (!canEdit) return;
        setCoAdmins(prev => prev.includes(n) ? prev.filter(x => x !== n) : [...prev, n]);
    }

    const tierLabel = (() => {
        const t = chat.editTier || 'staff';
        if (t === 'admin')   return tx('Only admins can edit',   'Solo los admins pueden editar');
        if (t === 'manager') return tx('Managers + admins can edit', 'Managers y admins pueden editar');
        return tx('Creator + admins can edit', 'Creador y admins pueden editar');
    })();

    return (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-end md:items-center justify-center" onClick={onClose}>
            <div
                className="bg-white w-full md:max-w-md md:rounded-2xl rounded-t-2xl flex flex-col max-h-[90vh] shadow-xl"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="md:hidden flex justify-center pt-2 pb-1">
                    <div className="w-10 h-1 bg-dd-line rounded-full" />
                </div>
                {/* Header */}
                <div className="px-4 py-3 border-b border-dd-line flex items-center gap-3">
                    <ChatAvatar chat={chat} viewerName={staffName} size={42} />
                    <div className="flex-1 min-w-0">
                        <div className="text-lg font-black text-dd-text truncate">
                            {chatDisplayName(chat, staffName)}
                        </div>
                        <div className="text-[11px] text-dd-text-2">
                            {isChannel ? tx('Team channel · auto-membership', 'Canal · membresía automática')
                                : isDm ? tx('Direct message', 'Mensaje directo')
                                : `${members.length} ${tx('members', 'miembros')} · ${tierLabel}`}
                        </div>
                    </div>
                    <button onClick={onClose} className="w-8 h-8 rounded-full hover:bg-dd-bg flex items-center justify-center">✕</button>
                </div>

                <div className="flex-1 overflow-y-auto p-3 space-y-3">
                    {/* Name + emoji (groups only) */}
                    {!isDm && (
                        <div>
                            <label className="block text-[11px] font-bold uppercase tracking-widest text-dd-text-2 mb-1">
                                {tx('Name + icon', 'Nombre + icono')}
                            </label>
                            <div className="flex items-center gap-2">
                                <button
                                    type="button"
                                    disabled={!canEdit}
                                    onClick={() => {
                                        const next = window.prompt(
                                            tx('Enter an emoji', 'Ingresa un emoji'),
                                            emoji
                                        );
                                        if (next) setEmoji(next.slice(0, 2));
                                    }}
                                    className="w-12 h-12 rounded-lg bg-dd-sage-50 border border-dd-line text-2xl flex items-center justify-center disabled:opacity-60"
                                >
                                    {emoji}
                                </button>
                                <input
                                    type="text"
                                    value={name}
                                    onChange={(e) => setName(e.target.value)}
                                    disabled={!canEdit}
                                    maxLength={60}
                                    className="flex-1 px-3 py-2 rounded-lg bg-white border border-dd-line text-sm focus:outline-none focus:ring-2 focus:ring-dd-green/30 disabled:bg-dd-bg disabled:text-dd-text-2"
                                />
                            </div>
                        </div>
                    )}

                    {/* Members section */}
                    <div>
                        <div className="flex items-center justify-between mb-1">
                            <label className="block text-[11px] font-bold uppercase tracking-widest text-dd-text-2">
                                {tx('Members', 'Miembros')} ({members.length})
                            </label>
                            {canEdit && !isChannel && !isDm && (
                                <button
                                    onClick={() => setShowAdd(s => !s)}
                                    className="text-xs font-bold text-dd-green hover:text-dd-green-700"
                                >
                                    {showAdd ? tx('Done', 'Listo') : `+ ${tx('Add', 'Añadir')}`}
                                </button>
                            )}
                        </div>

                        {showAdd && canEdit && !isChannel && !isDm && (
                            <div className="border border-dd-green/30 rounded-lg max-h-[200px] overflow-y-auto mb-2">
                                {addable.length === 0 ? (
                                    <div className="px-3 py-4 text-center text-xs text-dd-text-2">
                                        {tx('Everyone is already in this group.', 'Todos ya están en este grupo.')}
                                    </div>
                                ) : addable.map(s => (
                                    <button
                                        key={s.name}
                                        onClick={() => { setMembers(prev => [...prev, s.name]); }}
                                        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-dd-bg text-left border-b border-dd-line/40 last:border-b-0"
                                    >
                                        <span className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-dd-green text-white text-[10px] font-black">
                                            {s.name.split(' ').map(p => p[0]).slice(0, 2).join('').toUpperCase()}
                                        </span>
                                        <span className="text-sm font-bold text-dd-text">{s.name}</span>
                                        {s.role && <span className="text-[11px] text-dd-text-2">{s.role}</span>}
                                        <span className="ml-auto text-dd-green text-lg">+</span>
                                    </button>
                                ))}
                            </div>
                        )}

                        <div className="border border-dd-line rounded-lg divide-y divide-dd-line/60">
                            {members.length === 0 && (
                                <div className="px-3 py-4 text-center text-xs text-dd-text-2">
                                    {tx('No members.', 'Sin miembros.')}
                                </div>
                            )}
                            {members.map(n => {
                                const isCreator = chat.createdBy === n;
                                const isCo = coAdmins.includes(n);
                                const isYou = n === staffName;
                                return (
                                    <div key={n} className="flex items-center gap-2 px-3 py-2">
                                        <span className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-dd-charcoal text-white text-[10px] font-black">
                                            {n.split(' ').map(p => p[0]).slice(0, 2).join('').toUpperCase()}
                                        </span>
                                        <div className="flex-1 min-w-0">
                                            <div className="text-sm font-bold text-dd-text truncate">
                                                {n} {isYou && <span className="text-[10px] text-dd-text-2 font-semibold">({tx('you', 'tú')})</span>}
                                            </div>
                                            <div className="text-[10px] text-dd-text-2">
                                                {isCreator
                                                    ? tx('Creator', 'Creador')
                                                    : isCo
                                                    ? tx('Co-admin', 'Co-admin')
                                                    : tx('Member', 'Miembro')}
                                            </div>
                                        </div>
                                        {canEdit && !isChannel && !isDm && (
                                            <>
                                                {chat.editTier === 'staff' && !isCreator && (
                                                    <button
                                                        onClick={() => toggleCoAdmin(n)}
                                                        className={`text-[10px] px-2 py-1 rounded font-bold ${isCo ? 'bg-dd-green/10 text-dd-green' : 'bg-dd-bg text-dd-text-2 hover:text-dd-text'}`}
                                                        title={tx('Co-admin can manage this group', 'Co-admin puede gestionar este grupo')}
                                                    >
                                                        {isCo ? tx('Co-admin ✓', 'Co-admin ✓') : tx('Make co-admin', 'Hacer co-admin')}
                                                    </button>
                                                )}
                                                {!isCreator && (
                                                    <button
                                                        onClick={() => toggleMember(n)}
                                                        className="text-dd-text-2 hover:text-red-600 w-7 h-7 rounded hover:bg-red-50 flex items-center justify-center"
                                                        aria-label={tx('Remove', 'Quitar')}
                                                    >
                                                        ✕
                                                    </button>
                                                )}
                                            </>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                        {isChannel && (
                            <div className="text-[11px] text-dd-text-2 mt-1.5 px-1">
                                {tx('Channels stay in sync with the staff list automatically.',
                                    'Los canales se sincronizan automáticamente con la lista del personal.')}
                            </div>
                        )}
                    </div>

                    {/* Edit-tier hint */}
                    {!isDm && (
                        <div className="text-[11px] text-dd-text-2 px-1 py-1 bg-dd-bg rounded border border-dd-line">
                            {tx('Created by ', 'Creado por ')}<b>{chat.createdBy}</b>
                            {' · '}{tierLabel}
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className="px-3 py-3 border-t border-dd-line flex items-center justify-between gap-2 shrink-0">
                    {!isChannel && !isDm && (
                        <button
                            onClick={handleLeave}
                            disabled={busy}
                            className="text-xs font-bold text-red-600 hover:text-red-700 px-2 py-2"
                        >
                            {tx('Leave', 'Salir')}
                        </button>
                    )}
                    {canEdit && !isDm && !isChannel && (
                        <button
                            onClick={handleDelete}
                            disabled={busy}
                            className="text-xs font-bold text-red-600 hover:text-red-700 px-2 py-2"
                        >
                            {tx('Delete group', 'Eliminar grupo')}
                        </button>
                    )}
                    <div className="flex-1" />
                    <button
                        onClick={onClose}
                        className="px-3 py-2 rounded-full text-sm font-bold text-dd-text-2 hover:bg-dd-bg"
                    >
                        {tx('Cancel', 'Cancelar')}
                    </button>
                    {canEdit && !isDm && (
                        <button
                            onClick={handleSave}
                            disabled={busy}
                            className="px-4 py-2 rounded-full bg-dd-green text-white font-bold text-sm shadow-sm disabled:opacity-40 hover:bg-dd-green-700"
                        >
                            {busy ? tx('Saving…', 'Guardando…') : tx('Save', 'Guardar')}
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}
