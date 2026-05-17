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
import { toast } from '../toast';
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
        // Location separation (2026-05-16): non-admins only see
        // same-location peers + 'both'-location staff. Admin sees all.
        const myLoc = viewer?.location;
        const sameLocation = (s) => {
            if (isAdmin) return true;
            if (!myLoc || myLoc === 'both') return true;
            if (s.location === 'both') return true;
            return s.location === myLoc;
        };
        return (staffList || [])
            .filter(s => s.name && !members.includes(s.name))
            .filter(sameLocation)
            .sort((a, b) => a.name.localeCompare(b.name));
    }, [staffList, members, viewer, isAdmin]);

    // Save name + emoji + co-admins. Member adds/removes auto-save
    // via addMemberNow / removeMemberNow below so the user doesn't
    // have to remember to tap Save before closing — a common
    // failure mode Andrew flagged where changes were getting lost.
    async function handleSave() {
        if (!canEdit || isDm || busy) return;
        setBusy(true);
        try {
            const patch = {};
            if (name.trim() && name.trim() !== chat.name) patch.name = name.trim().slice(0, 60);
            if (emoji && emoji !== chat.emoji) patch.emoji = emoji;
            // Channels: never overwrite members from this modal.
            if (!isChannel) {
                patch.admins = coAdmins.filter(n => members.includes(n));
            }
            if (Object.keys(patch).length > 0) {
                await updateDoc(doc(db, 'chats', chat.id), patch);
            }
            onClose();
        } catch (e) {
            console.warn('chat update failed:', e);
            toast(tx('Save failed', 'Error al guardar'), { kind: 'error' });
        } finally {
            setBusy(false);
        }
    }

    // ── Auto-save member changes ────────────────────────────────
    // Each Add or Remove writes to Firestore immediately so the
    // change is durable the moment the user taps. No "save before
    // closing" gotcha. Optimistic local update so the UI moves
    // instantly; we rollback if the write fails.
    const [memberBusy, setMemberBusy] = useState(false);
    async function addMemberNow(name) {
        if (!canEdit || isDm || memberBusy) return;
        const prev = members;
        const next = Array.from(new Set([...prev, name]));
        setMembers(next);
        setMemberBusy(true);
        try {
            await updateDoc(doc(db, 'chats', chat.id), {
                members: Array.from(new Set([chat.createdBy, ...next].filter(Boolean))),
            });
            recordAudit({
                action: 'chat.member.add',
                actorName: staffName,
                actorId: viewer?.id,
                targetType: 'chat',
                targetId: chat.id,
                details: { added: name, chatType: chat.type, channelKey: chat.channelKey || null },
            });
        } catch (e) {
            console.warn('add member failed:', e);
            setMembers(prev); // rollback
            toast(tx('Could not add — try again', 'No se pudo añadir — intenta de nuevo'), { kind: 'error' });
        } finally {
            setMemberBusy(false);
        }
    }
    async function removeMemberNow(name) {
        if (!canEdit || isDm || memberBusy) return;
        if (chat.createdBy === name) {
            toast(tx('Cannot remove the creator. They can leave on their own.',
                     'No se puede quitar al creador. Solo ellos pueden salir.'),
                  { kind: 'warn' });
            return;
        }
        const prev = members;
        const next = prev.filter(n => n !== name);
        setMembers(next);
        const prevCo = coAdmins;
        const nextCo = prevCo.filter(n => n !== name);
        setCoAdmins(nextCo);
        setMemberBusy(true);
        try {
            await updateDoc(doc(db, 'chats', chat.id), {
                members: Array.from(new Set([chat.createdBy, ...next].filter(Boolean))),
                admins: nextCo.filter(n => next.includes(n)),
            });
            recordAudit({
                action: 'chat.member.remove',
                actorName: staffName,
                actorId: viewer?.id,
                targetType: 'chat',
                targetId: chat.id,
                details: { removed: name, chatType: chat.type, channelKey: chat.channelKey || null },
            });
        } catch (e) {
            console.warn('remove member failed:', e);
            setMembers(prev);
            setCoAdmins(prevCo);
            toast(tx('Could not remove — try again', 'No se pudo quitar — intenta de nuevo'), { kind: 'error' });
        } finally {
            setMemberBusy(false);
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
            toast(tx('Delete failed', 'Error al eliminar'), { kind: 'error' });
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
            if (confirmText !== null) toast(tx('Cancelled — phrase did not match.', 'Cancelado — la frase no coincide.'), { kind: 'info' });
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
            // 4. Tombstone — without this the AppDataContext / ChatCenter
            //    auto-sync would re-create the channel on next mount.
            //    Andrew flagged this bug after deleting a channel and
            //    watching it come back. The tombstone is keyed by the
            //    same doc id so the sync's "skip if tombstoned" check
            //    catches it. Stored under /chats_purged.
            try {
                await setDoc(doc(db, 'chats_purged', chat.id), {
                    purgedAt: serverTimestamp(),
                    purgedBy: staffName,
                    chatType: chat.type,
                    channelKey: chat.channelKey || null,
                    chatName: chat.name || null,
                });
            } catch (e) {
                console.warn('tombstone write failed (non-fatal):', e);
            }
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
            toast(tx('Hard delete failed: ', 'Borrado permanente falló: ') + (e.message || e), { kind: 'error', duration: 6000 });
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

                    {/* Members section — explicit Add Staff button +
                        labeled Remove on each row. All changes are
                        AUTO-SAVED the moment you tap — no "save before
                        closing" footgun.
                        Channels: admin can override auto-membership
                        with a warning that re-sync may revert the
                        change unless the source data also changes. */}
                    <div>
                        <div className="flex items-center justify-between mb-1">
                            <label className="block text-[11px] font-bold uppercase tracking-widest text-dd-text-2">
                                {tx('Members', 'Miembros')} · {members.length}
                            </label>
                            {!isDm && (canEdit || (isChannel && isAdmin)) && (
                                <button
                                    onClick={() => setShowAdd(s => !s)}
                                    className={`px-3 py-1.5 rounded-full font-bold text-xs shadow-sm transition active:scale-95 ${showAdd
                                        ? 'bg-dd-bg text-dd-text border border-dd-line'
                                        : 'bg-dd-green text-white hover:bg-dd-green-700'}`}
                                >
                                    {showAdd ? `✓ ${tx('Done adding', 'Listo')}` : `+ ${tx('Add staff', 'Añadir personal')}`}
                                </button>
                            )}
                        </div>
                        {!isDm && (canEdit || (isChannel && isAdmin)) && (
                            <p className="text-[10px] text-dd-text-2 mb-2 italic">
                                {tx('Add or remove saves instantly — the chat keeps its messages.',
                                    'Añadir o quitar se guarda al instante — el chat conserva sus mensajes.')}
                            </p>
                        )}

                        {isChannel && showAdd && isAdmin && (
                            <div className="mb-2 px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-[11px] text-amber-900">
                                ⚠ {tx(
                                    'Channels auto-sync from the staff list. Manual adds here may revert on next load unless the staff member also matches the channel rule (location / side).',
                                    'Los canales se sincronizan automáticamente. Adiciones manuales pueden revertirse al recargar si el staff no coincide con la regla del canal.'
                                )}
                            </div>
                        )}

                        {showAdd && !isDm && (canEdit || (isChannel && isAdmin)) && (
                            <div className="border border-dd-green/30 rounded-lg max-h-[220px] overflow-y-auto mb-2">
                                {addable.length === 0 ? (
                                    <div className="px-3 py-4 text-center text-xs text-dd-text-2">
                                        {tx('Everyone is already in this chat.', 'Todos ya están en este chat.')}
                                    </div>
                                ) : addable.map(s => (
                                    <button
                                        key={s.name}
                                        onClick={() => addMemberNow(s.name)}
                                        disabled={memberBusy}
                                        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-dd-sage-50 text-left border-b border-dd-line/40 last:border-b-0 disabled:opacity-50"
                                    >
                                        <span className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-dd-green text-white text-[10px] font-black">
                                            {s.name.split(' ').map(p => p[0]).slice(0, 2).join('').toUpperCase()}
                                        </span>
                                        <span className="flex-1 min-w-0">
                                            <span className="block text-sm font-bold text-dd-text truncate">{s.name}</span>
                                            {s.role && <span className="block text-[10px] text-dd-text-2">{s.role} · {s.location || '—'}</span>}
                                        </span>
                                        <span className="px-2 py-1 rounded-full bg-dd-green text-white text-[10px] font-black shrink-0">
                                            + {tx('Add', 'Añadir')}
                                        </span>
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
                                        {!isDm && (canEdit || (isChannel && isAdmin)) && (
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
                                                        onClick={() => removeMemberNow(n)}
                                                        disabled={memberBusy}
                                                        className="px-2.5 py-1.5 rounded-full text-[11px] font-bold bg-red-50 text-red-700 border border-red-200 hover:bg-red-100 active:scale-95 transition flex items-center gap-1 disabled:opacity-50"
                                                        aria-label={tx('Remove', 'Quitar')}
                                                        title={tx('Remove from chat', 'Quitar del chat')}
                                                    >
                                                        <span>✕</span><span>{tx('Remove', 'Quitar')}</span>
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
                                {tx('Channels stay in sync with the staff list automatically. To curate membership, start a group instead.',
                                    'Los canales se sincronizan automáticamente. Para gestionar miembros, crea un grupo.')}
                            </div>
                        )}
                        {isDm && (
                            <div className="text-[11px] text-dd-text-2 mt-1.5 px-1">
                                {tx('Direct messages are 1-on-1. To bring in a third person, start a new group from the + button on the chat list.',
                                    'Los DM son 1-a-1. Para incluir a una tercera persona, crea un grupo nuevo con el botón + en la lista.')}
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
