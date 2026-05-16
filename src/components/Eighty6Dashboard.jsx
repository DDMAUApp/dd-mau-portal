// Eighty6Dashboard — live "what we're out of" board for the kitchen.
//
// 2026-05-10 rewrite: ported from a heavy dark-mode standalone look
// (#111827 + red gradient — felt like a different app dropped into
// the v2 shell) to the v2 sage/white palette so it sits naturally
// inside AppShellV2. Visual language now matches the rest of the app:
//   • White card chrome with subtle border/shadow
//   • Color used semantically (red = critical 86, amber = low stock,
//     green = all-clear) — not as the page chrome
//   • Big readable count + timestamp at the top so cooks reading from
//     across the line can see status at a glance
//   • Each item card is a tap-friendly chip with status pill on the right
//
// Read-only at this view layer — admins toggle 86 status from the
// Operations page (Tasks / Inventory tabs).

import { useState, useEffect } from 'react';
import { onSnapshot, doc, setDoc, addDoc, collection, serverTimestamp, getDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { toast } from '../toast';

export default function Eighty6Dashboard({ language, storeLocation, staffName, staffList = [], isAdmin = false }) {
    const [items, setItems] = useState([]);
    const [count, setCount] = useState(0);
    const [updatedAt, setUpdatedAt] = useState(null);
    // Attribution map written by scripts/sync-toast-86-attribution.mjs.
    // Shape: { [itemName]: { outBy: [staffName,...], outAt: Timestamp,
    //                        inBy: [...], inAt: Timestamp } }
    // Items that haven't been seen transition yet (legacy / from before
    // the sync script started running) won't have an entry — display
    // gracefully degrades to no name shown.
    const [attribution, setAttribution] = useState({});
    const [loading, setLoading] = useState(true);
    // 2026-05-16 — alert settings: hours of day when scheduled reminders
    // fire + global on/off. Stored at /config/eighty_six_alerts. Read here
    // so the dashboard surfaces current config to admins (Edit button)
    // and so we can compose accurate test-send pings using the current
    // recipient gate.
    const [alertSettings, setAlertSettings] = useState({ enabled: true, enabledHours: [10, 14, 20] });
    const [showSettings, setShowSettings] = useState(false);
    const [sending, setSending] = useState(false);
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);

    // Alert settings live subscription. Defaults preserved when the doc
    // doesn't exist yet (matches the Cloud Function's fallback behavior).
    useEffect(() => {
        const unsub = onSnapshot(doc(db, 'config', 'eighty_six_alerts'), (snap) => {
            if (snap.exists()) {
                const d = snap.data() || {};
                setAlertSettings({
                    enabled: d.enabled !== false,
                    enabledHours: Array.isArray(d.enabledHours) ? d.enabledHours : [10, 14, 20],
                });
            }
        }, (err) => console.warn('alert settings snapshot failed:', err));
        return unsub;
    }, []);

    // Recipients = staff with canReceive86Alerts === true. Dedup by name.
    const recipients = (() => {
        const seen = new Set();
        const out = [];
        for (const s of (staffList || [])) {
            if (!s || !s.name) continue;
            if (s.canReceive86Alerts !== true) continue;
            if (seen.has(s.name)) continue;
            seen.add(s.name);
            out.push(s);
        }
        return out;
    })();

    // 2026-05-16 — manual "send test reminder" — mirrors the Cloud
    // Function's scheduled-alert composition, but fires immediately.
    // Andrew: "the 86 page didnt send a reminder of what out of stock
    // lets send a reminder test." Useful both for verifying recipients
    // are configured AND for ad-hoc "we just 86'd 3 things, ping the
    // line right now" cases.
    const sendTestReminder = async () => {
        if (sending) return;
        setSending(true);
        try {
            // Pull current 86 list for BOTH locations (matches scheduled).
            const [wSnap, mSnap] = await Promise.all([
                getDoc(doc(db, 'ops', '86_webster')),
                getDoc(doc(db, 'ops', '86_maryland')),
            ]);
            const outOf = (snap) => {
                if (!snap.exists()) return [];
                const items = (snap.data() || {}).items || [];
                return items.filter(i => i?.status === 'OUT_OF_STOCK' && i?.name).map(i => i.name);
            };
            const websterOut = outOf(wSnap);
            const marylandOut = outOf(mSnap);
            const totalOut = websterOut.length + marylandOut.length;
            if (recipients.length === 0) {
                toast(tx('No staff have 86 alerts turned on. Set it in Admin → Staff.',
                          'Ningún miembro del personal tiene alertas 86 activadas. Configúralas en Admin → Personal.'),
                    { kind: 'error', duration: 6000 });
                return;
            }
            const lines = [];
            if (websterOut.length > 0) lines.push(`Webster: ${websterOut.join(', ')}`);
            if (marylandOut.length > 0) lines.push(`Maryland: ${marylandOut.join(', ')}`);
            const title = totalOut > 0
                ? `🚫 ${totalOut} item${totalOut === 1 ? '' : 's'} 86'd ${tx('(test)', '(prueba)')}`
                : `✅ ${tx('All items in stock (test)', 'Todo en stock (prueba)')}`;
            const body = totalOut > 0
                ? lines.join(' · ')
                : tx('Nothing 86\'d right now — this is just a test reminder.',
                     'Nada en 86 ahora — esta es una notificación de prueba.');
            const tag = `eighty_six_alert:test:${Date.now()}`; // unique tag — never collapses
            await Promise.all(recipients.map(r =>
                addDoc(collection(db, 'notifications'), {
                    forStaff: r.name,
                    type: 'eighty_six_alert',
                    title,
                    body,
                    link: '/eighty6',
                    tag,
                    createdAt: serverTimestamp(),
                    read: false,
                    createdBy: `${staffName || 'admin'}:test`,
                })
            ));
            toast(tx(`✓ Test reminder sent to ${recipients.length} staff member${recipients.length === 1 ? '' : 's'}`,
                      `✓ Recordatorio de prueba enviado a ${recipients.length} miembro${recipients.length === 1 ? '' : 's'}`),
                { kind: 'success', duration: 4000 });
        } catch (e) {
            console.error('test reminder failed:', e);
            toast(tx('Could not send test: ', 'No se pudo enviar: ') + (e.message || e), { kind: 'error' });
        } finally {
            setSending(false);
        }
    };

    // Toggle an hour in/out of the alert schedule. Settings doc is
    // created with merge so concurrent admin edits don't clobber siblings.
    const toggleAlertHour = async (hour) => {
        const cur = Array.isArray(alertSettings.enabledHours) ? alertSettings.enabledHours : [];
        const next = cur.includes(hour) ? cur.filter(h => h !== hour) : [...cur, hour].sort((a, b) => a - b);
        try {
            await setDoc(doc(db, 'config', 'eighty_six_alerts'), {
                enabled: alertSettings.enabled,
                enabledHours: next,
                updatedAt: serverTimestamp(),
                updatedBy: staffName || 'admin',
            }, { merge: true });
        } catch (e) {
            console.error('toggleAlertHour failed:', e);
            toast(tx('Could not save: ', 'No se pudo guardar: ') + e.message, { kind: 'error' });
        }
    };
    const toggleAlertsEnabled = async () => {
        try {
            await setDoc(doc(db, 'config', 'eighty_six_alerts'), {
                enabled: !alertSettings.enabled,
                enabledHours: alertSettings.enabledHours,
                updatedAt: serverTimestamp(),
                updatedBy: staffName || 'admin',
            }, { merge: true });
        } catch (e) {
            console.error('toggleAlertsEnabled failed:', e);
            toast(tx('Could not save: ', 'No se pudo guardar: ') + e.message, { kind: 'error' });
        }
    };

    useEffect(() => {
        const docKey = `86_${storeLocation === 'both' ? 'webster' : storeLocation}`;
        const unsubscribe = onSnapshot(doc(db, "ops", docKey), (docSnapshot) => {
            if (docSnapshot.exists()) {
                const data = docSnapshot.data();
                setItems(data.items || []);
                setCount(data.count || 0);
                setUpdatedAt(data.updatedAt || null);
                setAttribution(data.attribution || {});
            } else {
                setItems([]); setCount(0); setUpdatedAt(null); setAttribution({});
            }
            setLoading(false);
        }, () => setLoading(false));
        return () => unsubscribe();
    }, [storeLocation]);

    const formatTime = (ts) => {
        if (!ts) return "—";
        try {
            const d = ts.toDate ? ts.toDate() : new Date(ts);
            const now = new Date();
            const diffMin = Math.round((now - d) / 60000);
            if (diffMin < 1) return tx('just now', 'ahora');
            if (diffMin < 60) return tx(`${diffMin} min ago`, `hace ${diffMin} min`);
            return d.toLocaleTimeString(isEs ? 'es' : 'en', { hour: 'numeric', minute: '2-digit' });
        } catch { return "—"; }
    };

    const locationLabel = storeLocation === 'maryland' ? tx('Maryland Heights', 'Maryland Heights')
                        : storeLocation === 'both'     ? tx('Both Locations', 'Ambas')
                        :                                tx('Webster Groves', 'Webster Groves');

    // Group items by status so 86'd shows above low-stock — cooks need
    // to see "what's totally out" first, then "what's running low".
    const out = items.filter(i => i.status === 'OUT_OF_STOCK');
    const low = items.filter(i => i.status !== 'OUT_OF_STOCK');

    return (
        <div className="space-y-4">
            {/* Header card — count is the headline. Big and tabular so it
                reads from across the kitchen. Color reflects state:
                green when fully stocked, red when anything's 86'd. */}
            <div className={`rounded-2xl shadow-card border overflow-hidden ${count > 0 ? 'bg-red-50 border-red-200' : 'bg-dd-green-50 border-dd-green/30'}`}>
                <div className="flex items-center justify-between gap-4 p-5">
                    <div className="min-w-0">
                        <div className={`text-[10px] font-bold uppercase tracking-widest ${count > 0 ? 'text-red-700' : 'text-dd-green-700'}`}>
                            🚫 {tx('86 Board', 'Tablero 86')}
                        </div>
                        <div className="text-sm font-bold text-dd-text mt-1 truncate">
                            {locationLabel} <span className="text-dd-text-2 font-semibold">— {tx('Out of stock', 'Agotados')}</span>
                        </div>
                        {updatedAt && (
                            <div className="text-[11px] text-dd-text-2 mt-1.5">
                                {tx('Updated', 'Actualizado')} {formatTime(updatedAt)}
                            </div>
                        )}
                    </div>
                    <div className="flex items-center gap-3 flex-shrink-0">
                        {/* Settings button — admin only. Opens the alerts
                            configuration modal (times + recipients summary
                            + send-test). */}
                        {isAdmin && (
                            <button onClick={() => setShowSettings(true)}
                                title={tx('Alert settings', 'Configuración de alertas')}
                                className="w-9 h-9 rounded-lg bg-white/70 hover:bg-white border border-dd-line text-dd-text-2 hover:text-dd-text transition flex items-center justify-center text-base">
                                ⚙️
                            </button>
                        )}
                        <div className="text-center">
                            <div className={`text-5xl font-black tabular-nums leading-none ${count > 0 ? 'text-red-700' : 'text-dd-green-700'}`}>
                                {count}
                            </div>
                            <div className={`text-[10px] font-bold uppercase tracking-wider mt-1 ${count > 0 ? 'text-red-700' : 'text-dd-green-700'}`}>
                                {count === 1 ? tx('item', 'artículo') : tx('items', 'artículos')}
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            {/* Body — empty state OR grouped lists */}
            {loading ? (
                <div className="space-y-2">
                    {[1,2,3].map(i => (
                        <div key={i} className="h-14 bg-white rounded-xl border border-dd-line animate-pulse" />
                    ))}
                </div>
            ) : items.length === 0 ? (
                <div className="text-center py-12 bg-white rounded-2xl border border-dd-line shadow-card">
                    <div className="text-5xl mb-2">✅</div>
                    <p className="text-base font-bold text-dd-green-700">
                        {tx('All items available!', '¡Todo disponible!')}
                    </p>
                    <p className="text-xs text-dd-text-2 mt-1">
                        {tx("No 86'd items right now", 'No hay artículos 86 en este momento')}
                    </p>
                </div>
            ) : (
                <div className="space-y-4">
                    {out.length > 0 && (
                        <Section
                            title={tx('Out of stock', 'Agotados')}
                            count={out.length}
                            tone="danger"
                            items={out}
                            attribution={attribution}
                            formatTime={formatTime}
                            isEs={isEs}
                        />
                    )}
                    {low.length > 0 && (
                        <Section
                            title={tx('Running low', 'Casi agotados')}
                            count={low.length}
                            tone="warn"
                            items={low}
                            attribution={attribution}
                            formatTime={formatTime}
                            isEs={isEs}
                        />
                    )}
                </div>
            )}

            {/* Alert settings modal — admin only. Configures cron times +
                shows recipient list + offers "send test reminder now". */}
            {showSettings && isAdmin && (
                <Eighty6SettingsModal
                    settings={alertSettings}
                    recipients={recipients}
                    isEs={isEs}
                    sending={sending}
                    onClose={() => setShowSettings(false)}
                    onToggleHour={toggleAlertHour}
                    onToggleEnabled={toggleAlertsEnabled}
                    onSendTest={sendTestReminder}
                />
            )}
        </div>
    );
}

// ── Eighty6SettingsModal ──────────────────────────────────────────────
// Surfaces the existing `canReceive86Alerts` per-staff toggle (read-only
// here — admin edits each via the AdminPanel staff edit form) alongside
// the new `/config/eighty_six_alerts` configuration: enabled toggle +
// 24-hour grid for picking when the daily reminder fires.
//
// The "Send test reminder now" button writes notification docs immediately
// — same shape the scheduled Cloud Function writes, so the FCM dispatch
// path is identical. Tag is unique-per-click so test pings never collapse
// with the next morning's scheduled one.
function Eighty6SettingsModal({ settings, recipients, isEs, sending, onClose, onToggleHour, onToggleEnabled, onSendTest }) {
    const tx = (en, es) => (isEs ? es : en);
    const formatHour = (h) => {
        const period = h >= 12 ? 'PM' : 'AM';
        const h12 = ((h + 11) % 12) + 1;
        return `${h12}${period}`;
    };
    return (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center p-0 sm:p-4">
            <div className="bg-white w-full sm:max-w-lg sm:rounded-2xl rounded-t-2xl max-h-[92vh] flex flex-col">
                <div className="border-b border-dd-line p-4 flex items-center justify-between flex-shrink-0">
                    <h3 className="text-lg font-bold text-dd-text">⚙️ {tx('86 Alert Settings', 'Configuración de Alertas 86')}</h3>
                    <button onClick={onClose} className="w-8 h-8 rounded-lg bg-dd-bg text-dd-text-2 hover:bg-dd-sage-50 text-lg">×</button>
                </div>

                <div className="flex-1 overflow-y-auto p-4 space-y-4">
                    {/* Send test — most prominent action since this is what Andrew
                        was specifically asking for. */}
                    <div className="rounded-xl border border-blue-200 bg-blue-50 p-3">
                        <p className="text-sm font-bold text-blue-900 mb-1">📣 {tx('Send a test reminder now', 'Enviar recordatorio de prueba')}</p>
                        <p className="text-[11px] text-blue-700 mb-3 leading-snug">
                            {tx('Pushes the current 86 list to every staff with "86 alerts" turned on. Useful for verifying recipients are configured AND for ad-hoc "we just 86\'d things, alert the line now" cases.',
                                'Envía la lista actual de 86 a todo el personal con "Alertas 86" activadas. Útil para verificar la configuración Y para casos puntuales de "acabamos de marcar cosas, avisa a la línea ya".')}
                        </p>
                        <button onClick={onSendTest} disabled={sending || recipients.length === 0}
                            className={`w-full py-2.5 rounded-lg font-bold text-sm transition ${sending || recipients.length === 0 ? 'bg-gray-300 text-gray-500 cursor-not-allowed' : 'bg-blue-600 text-white hover:bg-blue-700 active:scale-95'}`}>
                            {sending ? tx('Sending…', 'Enviando…') : tx(`Send test to ${recipients.length} staff`, `Enviar prueba a ${recipients.length} miembro${recipients.length === 1 ? '' : 's'}`)}
                        </button>
                    </div>

                    {/* Enabled toggle */}
                    <div className="rounded-xl border border-dd-line p-3">
                        <div className="flex items-center justify-between">
                            <div className="min-w-0 flex-1">
                                <p className="text-sm font-bold text-dd-text">{tx('Scheduled reminders', 'Recordatorios programados')}</p>
                                <p className="text-[11px] text-dd-text-2 leading-snug mt-0.5">
                                    {tx('When ON, sends a reminder at each picked hour of day if anything is still 86\'d. Silent when nothing is out.',
                                        'Cuando está activo, envía un recordatorio en cada hora elegida si hay algo en 86. Silencioso cuando todo está en stock.')}
                                </p>
                            </div>
                            <button onClick={onToggleEnabled}
                                className={`w-14 h-8 rounded-full transition relative flex-shrink-0 ml-3 ${settings.enabled ? 'bg-dd-green' : 'bg-gray-300'}`}>
                                <div className={`w-6 h-6 bg-white rounded-full shadow absolute top-1 transition-transform ${settings.enabled ? 'translate-x-7' : 'translate-x-1'}`} />
                            </button>
                        </div>
                    </div>

                    {/* Hours grid — 24 cells, click to toggle */}
                    <div className="rounded-xl border border-dd-line p-3">
                        <p className="text-sm font-bold text-dd-text mb-1">⏰ {tx('Times of day', 'Horas del día')}</p>
                        <p className="text-[11px] text-dd-text-2 mb-3 leading-snug">
                            {tx('Tap an hour to add/remove a reminder time. Times are in Central time. Picks usually look like: 10am / 2pm / 8pm.',
                                'Toca una hora para agregar/quitar un horario. Hora Central. Lo típico: 10am / 2pm / 8pm.')}
                        </p>
                        <div className="grid grid-cols-6 gap-1.5">
                            {Array.from({ length: 24 }, (_, h) => {
                                const on = (settings.enabledHours || []).includes(h);
                                return (
                                    <button key={h} onClick={() => onToggleHour(h)}
                                        className={`py-1.5 rounded text-[11px] font-bold border transition ${on ? 'bg-dd-green text-white border-dd-green' : 'bg-white text-dd-text-2 border-dd-line hover:border-dd-text-2'}`}>
                                        {formatHour(h)}
                                    </button>
                                );
                            })}
                        </div>
                        <p className="text-[10px] text-amber-700 mt-2 leading-snug italic">
                            ⚠ {tx('Schedule changes take effect after the Cloud Function next polls — within an hour. Test send fires immediately regardless.',
                                  'Los cambios de horario surten efecto cuando la Cloud Function vuelve a consultar — dentro de una hora. La prueba se envía de inmediato.')}
                        </p>
                    </div>

                    {/* Recipients (read-only) */}
                    <div className="rounded-xl border border-dd-line p-3">
                        <p className="text-sm font-bold text-dd-text mb-1">👥 {tx('Recipients', 'Destinatarios')}</p>
                        <p className="text-[11px] text-dd-text-2 mb-1 leading-snug">
                            {tx('Anyone with "86 alerts" toggled on in their staff profile. Toggle per-staff in Admin → Staff (✏️ or Bulk Tag).',
                                'Cualquier persona con "Alertas 86" activado en su perfil. Cámbialo por persona en Admin → Personal.')}
                        </p>
                        {/* 2026-05-16 — explain the on-duty filter. */}
                        <p className="text-[11px] text-dd-text-2 mb-2 leading-snug italic">
                            {tx('Scheduled + real-time pings are filtered to staff on the schedule today (owners always receive). Test send below ignores this filter and goes to everyone — useful for verifying recipient config.',
                                'Las alertas programadas y en tiempo real se filtran al personal en el horario de hoy (los dueños siempre reciben). La prueba ignora este filtro y va a todos — útil para verificar la configuración.')}
                        </p>
                        {recipients.length === 0 ? (
                            <div className="text-[11px] text-red-700 bg-red-50 border border-red-200 rounded p-2">
                                ⚠ {tx('Nobody has 86 alerts turned on. Go to Admin → Staff → Bulk Tag → toggle 🚫 86 alerts on the people who should get pushes.',
                                       'Nadie tiene alertas 86 activadas. Ve a Admin → Personal → Etiquetar en lote → activa 🚫 Alertas 86 para quienes deberían recibirlas.')}
                            </div>
                        ) : (
                            <div className="flex flex-wrap gap-1">
                                {recipients.map(r => (
                                    <span key={r.id || r.name} className="inline-flex items-center px-2 py-0.5 rounded-full bg-dd-bg border border-dd-line text-[11px] font-bold text-dd-text">
                                        {r.name}
                                    </span>
                                ))}
                            </div>
                        )}
                    </div>
                </div>

                <div className="border-t border-dd-line p-3 flex-shrink-0">
                    <button onClick={onClose}
                        className="w-full py-2 rounded-lg bg-dd-charcoal text-white font-bold text-sm">
                        {tx('Done', 'Listo')}
                    </button>
                </div>
            </div>
        </div>
    );
}

function Section({ title, count, tone, items, attribution = {}, formatTime, isEs }) {
    const accent = tone === 'danger' ? 'bg-red-500' : 'bg-amber-500';
    const pill   = tone === 'danger' ? 'bg-red-50 text-red-700 border-red-200'
                                     : 'bg-amber-50 text-amber-800 border-amber-200';
    const itemBg = tone === 'danger' ? 'bg-white border-red-200 hover:bg-red-50/50'
                                     : 'bg-white border-amber-200 hover:bg-amber-50/50';
    // Render the attribution line under an item name when present.
    // outBy may be a single name or a list (when multiple staff were
    // clocked in at the moment of the 86 transition). Show first names
    // for compactness when there are multiple; full name when only one.
    const renderAttribution = (itemName) => {
        const attr = attribution?.[itemName];
        if (!attr) return null;
        const list = Array.isArray(attr.outBy) ? attr.outBy : (attr.outBy ? [attr.outBy] : []);
        if (list.length === 0 && !attr.outAt) return null;
        const namesStr = list.length === 1
            ? list[0]
            : list.length > 1
                ? list.map(n => n.split(' ')[0]).join(' or ')
                : null;
        const timeStr = attr.outAt ? formatTime(attr.outAt) : null;
        return (
            <div className="text-[10px] text-dd-text-2 mt-0.5 italic">
                {namesStr && <>🙋 {isEs ? `Marcado por ${namesStr}` : `Marked by ${namesStr}`}</>}
                {namesStr && timeStr && <> · </>}
                {timeStr && <>{isEs ? 'a las' : 'at'} {timeStr}</>}
            </div>
        );
    };
    return (
        <div className="bg-white rounded-2xl border border-dd-line shadow-card overflow-hidden">
            <div className="flex items-center gap-2 px-4 py-2.5 border-b border-dd-line bg-dd-bg/40">
                <span className={`w-1 h-5 rounded-full ${accent}`} />
                <h3 className="text-sm font-bold text-dd-text flex-1">{title}</h3>
                <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border ${pill}`}>
                    {count}
                </span>
            </div>
            <ul className="divide-y divide-dd-line">
                {items.map((item, idx) => (
                    <li key={idx} className={`flex items-start justify-between gap-3 px-4 py-3 transition ${itemBg}`}>
                        <div className="min-w-0 flex-1">
                            <span className="font-bold text-dd-text truncate block">
                                {item.name}
                            </span>
                            {/* Attribution from sync-toast-86-attribution.mjs.
                                Shows who was clocked in at the moment of the
                                transition. When multiple staff overlap, lists
                                first names separated by "or" — manager can
                                pin down which one verbally. */}
                            {item.status === 'OUT_OF_STOCK' && renderAttribution(item.name)}
                        </div>
                        <span className={`flex-shrink-0 text-[11px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-md border ${pill}`}>
                            {item.status === 'OUT_OF_STOCK'
                                ? (isEs ? '86' : "86'd")
                                : (isEs ? `Quedan ${item.quantity}` : `${item.quantity} left`)}
                        </span>
                    </li>
                ))}
            </ul>
        </div>
    );
}
