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
import { doc, deleteDoc, updateDoc, serverTimestamp, collection, getDocs, writeBatch } from 'firebase/firestore';
import { canEditChat } from '../data/chat';
import { canDeleteChat } from '../data/chatPermissions';
import { recordAudit } from '../data/audit';
import { ChatAvatar, chatDisplayName } from './ChatCenter';

export default function ChatSettingsModal({
    chat, language, staffName, staffList, isAdmin, viewer, onClose, onDeleted,
}) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);
    const canEdit = canEditChat(chat, viewer, isAdmin);
    const canDelete = canDeleteChat(chat, viewer, isAdmin);
    const isChannel = chat.type === 'channel';
    const isDm = chat.type === 'dm';

    const [name, setName] = useState(chat.name || '');
    const [emoji, setEmoji] = useState(chat.emoji || '💬');
    const [members, setMembers] = useState(Array.isArray(chat.members) ? chat.members : []);
    const [coAdmins, setCoAdmins] = useState(Array.isArray(chat.admins) ? chat.admins : []);
    const [showAdd, setShowAdd] = useState(false);
    const [busy, setBusy] = useState(false);

    const addable = useMemo(() => {
        // hideFromSchedule suppresses schedule-grid rendering — not
        // chat membership. Don't filter here. (2026-05-16 fix.)
        return (staffList || [])
            .filter(s => s.name && !members.includes(s.name))
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

    // Soft delete = clear members → vanishes from every chat list.
    // Keeps the doc as a stub so audit + notification deep-links don't
    // 404. Works for DMs, groups, and channels.
    //
    // For channels: the AppDataContext / ChatCenter auto-sync would
    // RE-CREATE the channel on next mount (since channels are managed).
    // To make a channel delete actually stick, we'd need a "purged"
    // flag — out of v1 scope. Admins deleting a channel today gets a
    // "fresh reset" effect — useful for clearing a polluted channel,
    // not for permanent removal.
    async function handleDelete() {
        if (!canDelete || busy) return;
        const typeLabel = isChannel
            ? tx('channel (note: it will auto-recreate on next load)',
                 'canal (nota: se recreará en el próximo arranque)')
            : isDm
            ? tx('direct message', 'mensaje directo')
            : tx('group', 'grupo');
        const ok = window.confirm(tx(
            `Delete this ${typeLabel}? It disappears for everyone. Messages stay in the audit log.`,
            `¿Eliminar este ${typeLabel}? Desaparece para todos. Los mensajes permanecen en el log.`
        ));
        if (!ok) return;
        setBusy(true);
        try {
            await updateDoc(doc(db, 'chats', chat.id), {
                members: [],
                deletedAt: serverTimestamp(),
                deletedBy: staffName,
            });
            recordAudit({
                action: 'chat.delete.soft',
                actorName: staffName,
                actorId: viewer?.id,
                actorRole: viewer?.role,
                targetType: 'chat',
                targetId: chat.id,
                details: {
                    chatType: chat.type,
                    chatName: chat.name || null,
                    channelKey: chat.channelKey || null,
                    memberCount: (chat.members || []).length,
                },
            });
            onDeleted();
        } catch (e) {
            console.warn('delete failed:', e);
            alert(tx('Delete failed', 'Error al eliminar'));
        } finally {
            setBusy(false);
        }
    }

    // HARD delete (admin-only) — purges the chat doc + every message in
    // the subcollection. Audit log retains the action record. Use case:
    // permanently nuking spam / mistaken / sensitive chats. Cannot be
    // undone by the app — only Firestore PITR.
    async function handleHardDelete() {
        if (!isAdmin || busy) return;
        const phrase = chat.type === 'dm'
            ? tx('DM', 'DM')
            : (chat.name || tx('chat', 'chat'));
        const confirmText = window.prompt(tx(
            `PERMANENT DELETE: this nukes the chat + every message inside it. To confirm, type DELETE`,
            `BORRADO PERMANENTE: esto elimina el chat + todos los mensajes. Para confirmar, escribe DELETE`
        ));
        if (confirmText !== 'DELETE') {
            if (confirmText !== null) alert(tx('Cancelled — phrase did not match.', 'Cancelado — la frase no coincide.'));
            return;
        }
        setBusy(true);
        try {
            // 1. Purge messages in batches of 400 (Firestore batch cap is 500;
            //    leave room for the parent delete + acks/pins/typing/reads).
            //    We loop because a single batch can't hold an arbitrary count.
            const messagesRef = collection(db, 'chats', chat.id, 'messages');
            // We re-fetch each iteration because batched deletes don't shrink
            // the unread snapshot we already have in memory.
            // eslint-disable-next-line no-constant-condition
            while (true) {
                const snap = await getDocs(messagesRef);
                if (snap.empty) break;
                const batch = writeBatch(db);
                let count = 0;
                snap.forEach(d => {
                    if (count >= 400) return;
                    batch.delete(d.ref);
                    count++;
                });
                await batch.commit();
                if (snap.size <= 400) break;
            }
            // 2. Purge subcollections (acks, pins, typing markers). Best-effort.
            for (const sub of ['acks', 'pins', 'typing']) {
                try {
                    const ref = collection(db, 'chats', chat.id, sub);
                    const snap = await getDocs(ref);
                    if (!snap.empty) {
                        const batch = writeBatch(db);
                        snap.forEach(d => batch.delete(d.ref));
                        await batch.commit();
                    }
                } catch (e) { /* sub may not exist — ignore */ }
            }
            // 3. Delete the chat doc itself.
            await deleteDoc(doc(db, 'chats', chat.id));
            recordAudit({
                action: 'chat.delete.hard',
                actorName: staffName,
                actorId: viewer?.id,
                actorRole: viewer?.role,
                targetType: 'chat',
                targetId: chat.id,
                details: {
                    chatType: chat.type,
                    chatName: chat.name || null,
                    channelKey: chat.channelKey || null,
                    memberCount: (chat.members || []).length,
                },
            });
            onDeleted();
        } catch (e) {
            console.warn('hard delete failed:', e);
            alert(tx('Hard delete failed: ', 'Borrado permanente falló: ') + (e.message || e));
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

                {/* Danger zone — soft delete (anyone with permission)
                    + hard delete (admin only). Inside its own bordered
                    block so it can't be tapped accidentally during
                    save flow. */}
                {(canDelete || isAdmin) && (
                    <div className="px-3 py-3 border-t border-dd-line bg-red-50/50">
                        <div className="text-[10px] font-black uppercase tracking-widest text-red-800 mb-2">
                            ⚠ {tx('Danger zone', 'Zona peligrosa')}
                        </div>
                        {canDelete && (
                            <button
                                onClick={handleDelete}
                                disabled={busy}
                                className="w-full text-left text-xs font-bold text-red-700 hover:bg-red-100 px-3 py-2 rounded border border-red-200 mb-1"
                            >
                                🗑 {isDm
                                    ? tx('Delete this DM', 'Eliminar este DM')
                                    : isChannel
                                    ? tx('Reset this channel (clears + re-syncs members)', 'Reiniciar canal (limpia y resincroniza)')
                                    : tx('Delete group', 'Eliminar grupo')}
                                <div className="text-[10px] font-normal text-red-700/80 mt-0.5">
                                    {tx('Disappears for everyone. Messages preserved in audit log.',
                                        'Desaparece para todos. Mensajes preservados en log.')}
                                </div>
                            </button>
                        )}
                        {isAdmin && (
                            <button
                                onClick={handleHardDelete}
                                disabled={busy}
                                className="w-full text-left text-xs font-black text-red-800 hover:bg-red-200 px-3 py-2 rounded border-2 border-red-400 bg-white"
                            >
                                💥 {tx('Permanently delete (admin)', 'Borrado permanente (admin)')}
                                <div className="text-[10px] font-normal text-red-700/80 mt-0.5">
                                    {tx('Purges every message. Cannot be undone.',
                                        'Borra todos los mensajes. No se puede deshacer.')}
                                </div>
                            </button>
                        )}
                    </div>
                )}

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
                    <div className="flex-1" />
                    <button
                        onClick={onClose}
                        className="px-3 py-2 rounded-full text-sm font-bold text-dd-text-2 hover:bg-dd-bg"
                    >
                        {tx('Close', 'Cerrar')}
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
