// Admin → Catering: the rules the catering order form checks (cateringRules.js).
// Saved to config/catering. Staff are warned about anything outside these and can
// still put an order in after confirming.
import { useEffect, useMemo, useState } from 'react';
import { doc, onSnapshot, setDoc as _fsSetDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { watchdogWrite } from '../data/firestoreRevive';
import { toast } from '../toast';
import { DAYS, DAY_LABELS, mergeSettings } from '../data/cateringRules';

const setDoc = (...a) => watchdogWrite(_fsSetDoc(...a));
const SETTINGS_REF = () => doc(db, 'config', 'catering');

const num = (v) => (v === '' || v === null || v === undefined ? 0 : Number(v));

export default function CateringSettings({ language = 'en', staffList = [], staffName }) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);
    const [saved, setSaved] = useState(null);
    const [draft, setDraft] = useState(null);
    const [busy, setBusy] = useState(false);
    const [newBlackout, setNewBlackout] = useState({ date: '', location: 'both', note: '' });

    useEffect(() => onSnapshot(SETTINGS_REF(), (snap) => {
        const s = mergeSettings(snap.exists() ? snap.data() : null);
        setSaved(s);
        setDraft(d => d || s);
    }, (e) => { console.warn('catering settings listen failed', e?.code); setSaved(mergeSettings(null)); setDraft(d => d || mergeSettings(null)); }), []);

    const dirty = useMemo(() => !!draft && !!saved && JSON.stringify(draft) !== JSON.stringify(saved), [draft, saved]);
    if (!draft) return <div className="glass-card p-4 text-sm">{tx('Loading…', 'Cargando…')}</div>;

    const set = (fn) => setDraft(d => fn(structuredClone(d)));
    const save = async () => {
        if (busy) return;
        setBusy(true);
        try {
            const clean = {
                ...draft,
                delivery: Object.fromEntries(Object.entries(draft.delivery).map(([k, v]) => [k, num(v)])),
                deliveryWindowMinutes: num(draft.deliveryWindowMinutes) || 30,
                blackouts: [...draft.blackouts].sort((a, b) => a.date.localeCompare(b.date)),
                updatedBy: staffName || '',
                updatedAt: new Date().toISOString(),
            };
            await setDoc(SETTINGS_REF(), clean);
            setDraft(mergeSettings(clean));
            toast(tx('Catering settings saved.', 'Ajustes de catering guardados.'), { kind: 'success' });
        } catch (e) {
            console.warn('catering settings save failed', e?.code);
            toast(tx('Could not save. Try again.', 'No se pudo guardar.'), { kind: 'error' });
        } finally { setBusy(false); }
    };

    const addBlackout = () => {
        if (!newBlackout.date) return;
        set(d => { d.blackouts.push({ ...newBlackout, note: newBlackout.note.trim() }); return d; });
        setNewBlackout({ date: '', location: 'both', note: '' });
    };
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
    const storeName = (l) => (l === 'webster' ? 'Webster' : l === 'maryland' ? 'Maryland Heights' : tx('Both stores', 'Ambas tiendas'));
    const input = 'border border-gray-300 rounded-lg px-2 py-2 text-sm bg-white';
    const section = 'rounded-xl border border-gray-200 bg-white p-3 space-y-2';

    // A plain function, not a component, so typing in a time box never remounts it.
    const windowTable = (kind, title) => (
        <div className={section}>
            <p className="font-bold text-sm">{title}</p>
            <div className="space-y-1">
                {DAYS.map(day => {
                    const w = draft.windows[kind][day];
                    return (
                        <div key={day} className="flex items-center gap-2 text-sm">
                            <label className="w-28 flex items-center gap-1.5">
                                <input type="checkbox" checked={w.open} onChange={e => set(d => { d.windows[kind][day].open = e.target.checked; return d; })} />
                                {tx(...DAY_LABELS[day])}
                            </label>
                            {w.open ? (
                                <>
                                    <input type="time" aria-label={tx(`${DAY_LABELS[day][0]} earliest`, `${DAY_LABELS[day][1]} más temprano`)} value={w.earliest} onChange={e => set(d => { d.windows[kind][day].earliest = e.target.value; return d; })} className={input} />
                                    <span className="text-gray-500">{tx('to', 'a')}</span>
                                    <input type="time" aria-label={tx(`${DAY_LABELS[day][0]} latest`, `${DAY_LABELS[day][1]} más tarde`)} value={w.latest} onChange={e => set(d => { d.windows[kind][day].latest = e.target.value; return d; })} className={input} />
                                </>
                            ) : <span className="text-gray-500">{tx('No orders', 'Sin pedidos')}</span>}
                        </div>
                    );
                })}
            </div>
        </div>
    );

    const money = (key, label) => (
        <label className="flex items-center justify-between gap-2 text-sm">
            <span>{label}</span>
            <input type="number" min="0" step="0.01" value={draft.delivery[key]} onChange={e => set(d => { d.delivery[key] = e.target.value; return d; })} className={`${input} w-28 text-right`} />
        </label>
    );
    const recipients = draft.notify.staffNames;
    const roster = (Array.isArray(staffList) ? staffList : []).filter(s => s?.name && !s.testMode).slice().sort((a, b) => a.name.localeCompare(b.name));

    return (
        <div className="glass-card p-4 space-y-3">
            <div className="flex items-center gap-2">
                <h3 className="flex-1 font-bold">🥡 {tx('Catering', 'Catering')}</h3>
                <button onClick={save} disabled={!dirty || busy} className="px-4 py-2 rounded-lg bg-dd-green text-white text-sm font-bold disabled:opacity-40">{busy ? tx('Saving…', 'Guardando…') : tx('Save', 'Guardar')}</button>
            </div>
            <p className="text-xs text-gray-600">{tx(
                'Staff taking an order get a warning for anything outside these rules. They can still put it in after confirming, and the order shows who did.',
                'El personal recibe un aviso si un pedido no cumple estas reglas. Pueden registrarlo después de confirmar, y el pedido muestra quién lo hizo.',
            )}</p>

            <div className={section}>
                <p className="font-bold text-sm">⛔ {tx('Blackout days', 'Días bloqueados')}</p>
                {draft.blackouts.length === 0 && <p className="text-xs text-gray-500">{tx('None yet.', 'Ninguno.')}</p>}
                {draft.blackouts.slice().sort((a, b) => a.date.localeCompare(b.date)).map((b) => (
                    <div key={`${b.date}-${b.location}-${b.note}`} className={`flex items-center gap-2 text-sm ${b.date < today ? 'opacity-50' : ''}`}>
                        <span className="font-bold tabular-nums">{b.date}</span>
                        <span className="text-gray-600">{storeName(b.location)}</span>
                        <span className="flex-1 text-gray-600 truncate">{b.note}</span>
                        <button aria-label={tx(`Remove ${b.date}`, `Quitar ${b.date}`)} onClick={() => set(d => { d.blackouts = d.blackouts.filter(x => !(x.date === b.date && x.location === b.location && x.note === b.note)); return d; })} className="px-2 py-1 rounded bg-gray-200 text-xs font-bold">✕</button>
                    </div>
                ))}
                <div className="flex flex-wrap items-center gap-2 pt-1">
                    <input type="date" aria-label={tx('Blackout date', 'Fecha bloqueada')} value={newBlackout.date} min={today} onChange={e => setNewBlackout(b => ({ ...b, date: e.target.value }))} className={input} />
                    <select aria-label={tx('Which store', 'Qué tienda')} value={newBlackout.location} onChange={e => setNewBlackout(b => ({ ...b, location: e.target.value }))} className={input}>
                        <option value="both">{tx('Both stores', 'Ambas tiendas')}</option>
                        <option value="webster">Webster</option>
                        <option value="maryland">Maryland Heights</option>
                    </select>
                    <input aria-label={tx('Reason', 'Motivo')} placeholder={tx('Reason (optional)', 'Motivo (opcional)')} value={newBlackout.note} onChange={e => setNewBlackout(b => ({ ...b, note: e.target.value }))} className={`${input} flex-1 min-w-[8rem]`} />
                    <button onClick={addBlackout} disabled={!newBlackout.date} className="px-3 py-2 rounded-lg bg-gray-800 text-white text-xs font-bold disabled:opacity-40">{tx('Add', 'Agregar')}</button>
                </div>
            </div>

            {windowTable('delivery', `🚗 ${tx('Delivery times (when the window can start)', 'Horas de entrega (cuándo puede empezar la ventana)')}`)}
            <label className="flex items-center justify-between gap-2 text-sm px-1">
                <span>{tx('Delivery window length (minutes)', 'Duración de la ventana de entrega (minutos)')}</span>
                <input type="number" min="0" step="5" value={draft.deliveryWindowMinutes} onChange={e => set(d => { d.deliveryWindowMinutes = e.target.value; return d; })} className={`${input} w-24 text-right`} />
            </label>
            {windowTable('pickup', `🏪 ${tx('Pickup times', 'Horas de recogida')}`)}

            <div className={section}>
                <p className="font-bold text-sm">💵 {tx('Delivery charges', 'Cargos de entrega')}</p>
                {money('minimumOrder', tx('Minimum order for delivery ($, 0 = none)', 'Pedido mínimo para entrega ($, 0 = ninguno)'))}
                {money('baseFee', tx('Delivery fee ($)', 'Tarifa de entrega ($)'))}
                {money('includedMiles', tx('Miles included in that fee', 'Millas incluidas en esa tarifa'))}
                {money('perMileOver', tx('Long-distance charge per mile after that ($)', 'Cargo por milla después ($)'))}
                {money('maxMiles', tx('Too far: more than this many miles (0 = no limit)', 'Muy lejos: más de estas millas (0 = sin límite)'))}
                <p className="text-xs text-gray-500">{tx(
                    'Miles are counted from the store the order comes from. Until the Google distance lookup is set up, staff type the miles.',
                    'Las millas se cuentan desde la tienda del pedido. Hasta configurar la búsqueda de Google, el personal escribe las millas.',
                )}</p>
                {['webster', 'maryland'].map(l => (
                    <label key={l} className="block text-sm">
                        <span className="text-xs text-gray-600">{storeName(l)} {tx('address', 'dirección')}</span>
                        <input value={draft.stores[l].address} onChange={e => set(d => { d.stores[l].address = e.target.value; return d; })} className={`${input} w-full`} />
                    </label>
                ))}
            </div>

            <div className={section}>
                <p className="font-bold text-sm">🔔 {tx('Who gets told about new orders', 'Quién recibe aviso de pedidos nuevos')}</p>
                <p className="text-xs text-gray-500">{recipients.length === 0
                    ? tx('Nobody picked: managers and owners get it, as now.', 'Nadie elegido: lo reciben gerentes y dueños, como ahora.')
                    : tx(`${recipients.length} picked. Only they get it.`, `${recipients.length} elegidos. Solo ellos lo reciben.`)}</p>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-1">
                    {roster.map(s => (
                        <label key={s.id ?? s.name} className="flex items-center gap-1.5 text-sm">
                            <input type="checkbox" checked={recipients.includes(s.name)} onChange={e => set(d => {
                                d.notify.staffNames = e.target.checked ? [...d.notify.staffNames, s.name] : d.notify.staffNames.filter(n => n !== s.name);
                                return d;
                            })} />
                            <span className="truncate">{s.name}</span>
                        </label>
                    ))}
                </div>
            </div>
            {dirty && <button onClick={save} disabled={busy} className="w-full py-3 rounded-lg bg-dd-green text-white font-bold disabled:opacity-40">{tx('Save changes', 'Guardar cambios')}</button>}
        </div>
    );
}
