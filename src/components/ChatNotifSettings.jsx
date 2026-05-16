// ChatNotifSettings — per-user notification policy editor.
//
// Stored at /chat_prefs/{staffName} as a single doc. The notification
// dispatch path will read this to honor quiet hours + channel mute.
// (Full Cloud Function enforcement is a follow-up; for v1 the doc is
// written + the client respects mutes on its own bell badge.)
//
// TODO multi-tenant: move to orgs/{orgId}/members/{userId}.notifPolicy.

import { useState, useEffect } from 'react';
import { db } from '../firebase';
import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import { DEFAULT_NOTIF_POLICY } from '../data/chat';
import { recordAudit } from '../data/audit';

export default function ChatNotifSettings({
    chats, language = 'en', staffName, viewer, onClose,
}) {
    const isEs = language === 'es';
    const tx = (en, es) => isEs ? es : en;

    const [policy, setPolicy] = useState(DEFAULT_NOTIF_POLICY);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        if (!staffName) return;
        (async () => {
            try {
                const ref = doc(db, 'chat_prefs', staffName);
                const snap = await getDoc(ref);
                if (snap.exists()) {
                    setPolicy({ ...DEFAULT_NOTIF_POLICY, ...snap.data() });
                }
            } catch (e) {
                console.warn('load notif policy:', e);
            } finally {
                setLoading(false);
            }
        })();
    }, [staffName]);

    async function handleSave() {
        if (busy) return;
        setBusy(true);
        try {
            await setDoc(doc(db, 'chat_prefs', staffName), {
                ...policy,
                staffName,
                updatedAt: serverTimestamp(),
            }, { merge: true });
            recordAudit({
                action: 'chat.notif_policy.update',
                actorName: staffName,
                actorId: viewer?.id,
                targetType: 'chat_prefs',
                targetId: staffName,
                details: { quietHours: !!policy.quietHours, digestMode: policy.digestMode },
            });
            onClose();
        } catch (e) {
            console.error('save notif policy:', e);
            alert(tx('Save failed', 'Error al guardar'));
        } finally {
            setBusy(false);
        }
    }

    function updateChannelPref(chatId, value) {
        setPolicy(p => ({
            ...p,
            channelPrefs: { ...p.channelPrefs, [chatId]: value },
        }));
    }

    if (loading) {
        return (
            <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center" onClick={onClose}>
                <div className="text-white text-sm">{tx('Loading…', 'Cargando…')}</div>
            </div>
        );
    }

    return (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-end md:items-center justify-center" onClick={onClose}>
            <div className="bg-white w-full md:max-w-md md:rounded-2xl rounded-t-2xl flex flex-col max-h-[90vh] shadow-xl" onClick={(e) => e.stopPropagation()}>
                <div className="md:hidden flex justify-center pt-2 pb-1">
                    <div className="w-10 h-1 bg-dd-line rounded-full" />
                </div>
                <div className="px-4 py-3 border-b border-dd-line flex items-center justify-between">
                    <h2 className="text-lg font-black text-dd-text">🔔 {tx('Notification settings', 'Notificaciones')}</h2>
                    <button onClick={onClose} className="w-8 h-8 rounded-full hover:bg-dd-bg flex items-center justify-center">✕</button>
                </div>

                <div className="flex-1 overflow-y-auto p-4 space-y-5">
                    {/* Master push toggle */}
                    <label className="flex items-center justify-between gap-3 p-3 rounded-lg bg-dd-bg cursor-pointer">
                        <div>
                            <div className="text-sm font-black text-dd-text">📲 {tx('Push notifications', 'Notificaciones push')}</div>
                            <div className="text-[11px] text-dd-text-2">{tx('Master switch for all phone alerts.', 'Maestro para todas las alertas.')}</div>
                        </div>
                        <input
                            type="checkbox"
                            checked={policy.pushEnabled !== false}
                            onChange={(e) => setPolicy(p => ({ ...p, pushEnabled: e.target.checked }))}
                            className="w-5 h-5"
                        />
                    </label>

                    {/* Quiet hours */}
                    <div className="p-3 rounded-lg border border-dd-line">
                        <label className="flex items-center justify-between gap-3 cursor-pointer">
                            <div>
                                <div className="text-sm font-black text-dd-text">🌙 {tx('Quiet hours', 'Horas silenciosas')}</div>
                                <div className="text-[11px] text-dd-text-2">{tx('Mute non-emergency pushes between these hours.', 'Silenciar pushes no urgentes en estas horas.')}</div>
                            </div>
                            <input
                                type="checkbox"
                                checked={!!policy.quietHours}
                                onChange={(e) => setPolicy(p => ({
                                    ...p,
                                    quietHours: e.target.checked ? { start: '22:00', end: '06:00' } : null,
                                }))}
                                className="w-5 h-5"
                            />
                        </label>
                        {policy.quietHours && (
                            <div className="mt-3 flex items-center gap-2 pl-1">
                                <label className="text-[11px] font-bold text-dd-text-2">{tx('From', 'Desde')}</label>
                                <input
                                    type="time"
                                    value={policy.quietHours.start}
                                    onChange={(e) => setPolicy(p => ({ ...p, quietHours: { ...p.quietHours, start: e.target.value } }))}
                                    className="px-2 py-1 rounded border border-dd-line text-sm"
                                />
                                <label className="text-[11px] font-bold text-dd-text-2">{tx('to', 'hasta')}</label>
                                <input
                                    type="time"
                                    value={policy.quietHours.end}
                                    onChange={(e) => setPolicy(p => ({ ...p, quietHours: { ...p.quietHours, end: e.target.value } }))}
                                    className="px-2 py-1 rounded border border-dd-line text-sm"
                                />
                            </div>
                        )}
                        <p className="mt-2 text-[10px] text-dd-text-2 italic">
                            {tx('Emergency 86 alerts and ack-required announcements still pierce quiet hours.',
                                'Las alertas de 86 de emergencia y los anuncios con acuse requerido aún suenan.')}
                        </p>
                    </div>

                    {/* Digest mode */}
                    <div className="p-3 rounded-lg border border-dd-line">
                        <div className="text-sm font-black text-dd-text mb-1">📦 {tx('Digest mode', 'Modo resumen')}</div>
                        <div className="text-[11px] text-dd-text-2 mb-2">{tx('How often to deliver non-urgent pushes.', 'Frecuencia de pushes no urgentes.')}</div>
                        <select
                            value={policy.digestMode || 'realtime'}
                            onChange={(e) => setPolicy(p => ({ ...p, digestMode: e.target.value }))}
                            className="w-full px-3 py-2 rounded-lg border border-dd-line bg-white text-sm"
                        >
                            <option value="realtime">{tx('Realtime (each message)', 'Tiempo real (cada mensaje)')}</option>
                            <option value="hourly">{tx('Hourly digest', 'Resumen cada hora')}</option>
                            <option value="daily">{tx('Daily digest', 'Resumen diario')}</option>
                        </select>
                    </div>

                    {/* Per-channel prefs */}
                    <div>
                        <div className="text-sm font-black text-dd-text mb-2">📍 {tx('Per-channel', 'Por canal')}</div>
                        <div className="border border-dd-line rounded-lg divide-y divide-dd-line/60">
                            {(chats || []).filter(c => c.type !== 'dm').slice(0, 30).map(c => (
                                <div key={c.id} className="flex items-center gap-3 px-3 py-2">
                                    <span className="text-xl shrink-0">{c.emoji || (c.type === 'channel' ? '#' : '👥')}</span>
                                    <span className="flex-1 min-w-0 text-sm font-bold text-dd-text truncate">{c.name}</span>
                                    <select
                                        value={policy.channelPrefs?.[c.id] || 'all'}
                                        onChange={(e) => updateChannelPref(c.id, e.target.value)}
                                        className="px-2 py-1 rounded border border-dd-line bg-white text-xs font-bold"
                                    >
                                        <option value="all">{tx('All', 'Todo')}</option>
                                        <option value="mentions">@{tx('Mentions', 'Menciones')}</option>
                                        <option value="none">{tx('Mute', 'Silenciar')}</option>
                                    </select>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>

                <div className="px-4 py-3 border-t border-dd-line flex items-center justify-end gap-3 shrink-0">
                    <button onClick={onClose} className="px-3 py-2 rounded-full text-sm font-bold text-dd-text-2 hover:bg-dd-bg">
                        {tx('Cancel', 'Cancelar')}
                    </button>
                    <button
                        onClick={handleSave}
                        disabled={busy}
                        className="px-4 py-2 rounded-full bg-dd-green text-white font-bold text-sm shadow-sm disabled:opacity-40 hover:bg-dd-green-700"
                    >
                        {busy ? tx('Saving…', 'Guardando…') : tx('Save', 'Guardar')}
                    </button>
                </div>
            </div>
        </div>
    );
}
