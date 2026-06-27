// MoneyCount — manager cash-drawer counter (Andrew 2026-06-25).
//
// Enter how many of each coin/bill → penny-exact running total → Save. Coins on
// the LEFT, bills on the RIGHT. A History view lists every past save with its
// timestamp + who counted it. Manager-gated (canCountMoney). All math in
// integer cents (src/data/moneyCount.js) so a drawer of pennies never drifts.

import { useState, useEffect, useMemo } from 'react';
import { Coins, Banknote, History, Save, Eraser, ChevronDown, Wallet, HandCoins, CalendarRange } from 'lucide-react';
import { toast } from '../toast';
import {
    COIN_DENOMS, BILL_DENOMS, totalCents, fmtMoney, saveMoneyCount, subscribeMoneyCounts,
    centralDate, dollarsToCents, saveCashTips, getCashTipsRange, editCashTips, missingTipDays,
} from '../data/moneyCount';
import { LOCATION_LABELS } from '../data/staff';

function fmtWhen(ms, isEn) {
    if (!ms) return '—';
    try {
        return new Date(ms).toLocaleString(isEn ? 'en-US' : 'es-US', {
            timeZone: 'America/Chicago', month: 'short', day: 'numeric',
            hour: 'numeric', minute: '2-digit',
        });
    } catch { return '—'; }
}

// One denomination row: label · count input · row subtotal.
function DenomRow({ denom, value, onChange, isEn }) {
    const n = Math.max(0, Math.floor(Number(value) || 0));
    return (
        <div className="py-1.5">
            <div className="flex items-center gap-2">
                <span className="w-9 shrink-0 text-sm font-black text-dd-text tabular-nums">{denom.label}</span>
                <input
                    type="number" inputMode="numeric" min="0" step="1"
                    value={value}
                    onChange={(e) => onChange(e.target.value)}
                    onFocus={(e) => e.target.select()}
                    placeholder="0"
                    aria-label={`${denom.label} ${isEn ? 'count' : 'cantidad'}`}
                    className="flex-1 min-w-0 px-2 py-2.5 text-lg font-bold text-dd-text bg-white border border-dd-line rounded-lg text-center tabular-nums focus:border-dd-green focus:ring-1 focus:ring-dd-green-50 outline-none"
                />
            </div>
            {n > 0 && (
                <div className="text-right text-[11px] font-bold text-dd-text-2 tabular-nums mt-0.5 pr-1">= {fmtMoney(denom.cents * n)}</div>
            )}
        </div>
    );
}

function Column({ title, Icon, denoms, counts, setCount, isEn }) {
    return (
        <div className="rounded-2xl border border-dd-line bg-white p-3">
            <div className="flex items-center gap-1.5 mb-1 text-[11px] font-black uppercase tracking-wider text-dd-text-2">
                <Icon size={13} strokeWidth={2.5} className="text-dd-green-700" />
                {title}
            </div>
            <div className="divide-y divide-dd-line/50">
                {denoms.map((d) => (
                    <DenomRow key={d.cents} denom={d} value={counts[d.cents] ?? ''} onChange={(v) => setCount(d.cents, v)} isEn={isEn} />
                ))}
            </div>
        </div>
    );
}

export default function MoneyCount({ language, storeLocation, staffName, staffList, staffId }) {
    const isEn = language !== 'es';
    const tx = (en, es) => (isEn ? en : es);
    const [view, setView] = useState('count');     // 'count' | 'history'
    const [counts, setCounts] = useState({});       // { [cents]: 'string' }
    const [saving, setSaving] = useState(false);
    const [history, setHistory] = useState(null);   // null = loading
    const [openId, setOpenId] = useState(null);
    const [locFilter, setLocFilter] = useState('all');
    // Cash tips — separate daily total.
    const [tipDate, setTipDate] = useState(() => centralDate());
    const [tipAmount, setTipAmount] = useState('');
    const [savingTip, setSavingTip] = useState(false);
    // History sub-mode + tip date-range lookup.
    const [histMode, setHistMode] = useState('counts');   // 'counts' | 'tips'
    const [tipFrom, setTipFrom] = useState(() => { const d = new Date(); d.setDate(d.getDate() - 13); return centralDate(d); });
    const [tipTo, setTipTo] = useState(() => centralDate());
    const [tipRows, setTipRows] = useState(null);   // null = not run yet
    const [loadingTips, setLoadingTips] = useState(false);
    const [loadedRange, setLoadedRange] = useState(null);   // the range tipRows was loaded for
    const [editTipId, setEditTipId] = useState(null);       // which tip row is being edited
    const [editTipVal, setEditTipVal] = useState('');
    const today = centralDate();

    // Resolve the counter's id (App may or may not pass it).
    const myId = staffId ?? (staffList || []).find((s) => s?.name === staffName)?.id ?? null;

    const total = useMemo(() => totalCents(
        Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, Number(v) || 0])),
    ), [counts]);
    const hasEntries = total > 0;

    useEffect(() => {
        const unsub = subscribeMoneyCounts(setHistory);
        return () => unsub();
    }, []);

    // Today's drawer counts at THIS store (morning → night), oldest first. They
    // roll into History automatically after midnight Central (the `date` field
    // changes, so they drop out of this filter on their own — no cron needed).
    const todayCounts = useMemo(() => {
        const list = Array.isArray(history) ? history : [];
        return list
            .filter((h) => h.date === today && h.location === storeLocation)
            .sort((a, b) => (a.createdMs || 0) - (b.createdMs || 0));
    }, [history, today, storeLocation]);

    const setCount = (cents, v) => {
        // keep digits only, allow empty
        const clean = String(v).replace(/[^\d]/g, '');
        setCounts((c) => ({ ...c, [cents]: clean }));
    };

    const clearAll = () => { setCounts({}); setOpenId(null); };

    const save = async () => {
        if (saving || !hasEntries) return;
        setSaving(true);
        try {
            await saveMoneyCount({ counts, staffName, staffId: myId, location: storeLocation });
            toast(tx(`Saved · ${fmtMoney(total)}`, `Guardado · ${fmtMoney(total)}`), { kind: 'success' });
            clearAll();
        } catch (e) {
            console.warn('money count save failed:', e);
            toast(tx('Could not save — try again.', 'No se pudo guardar — inténtalo de nuevo.'), { kind: 'error' });
        } finally {
            setSaving(false);
        }
    };

    // ── Cash tips ──
    const tipCents = dollarsToCents(tipAmount);
    const saveTip = async () => {
        if (savingTip || tipCents <= 0 || !tipDate) return;
        setSavingTip(true);
        try {
            await saveCashTips({ date: tipDate, amountCents: tipCents, staffName, staffId: myId, location: storeLocation });
            toast(tx(`Tips saved · ${fmtMoney(tipCents)}`, `Propinas guardadas · ${fmtMoney(tipCents)}`), { kind: 'success' });
            setTipAmount('');
        } catch (e) {
            console.warn('cash tips save failed:', e);
            toast(tx('Could not save tips — try again.', 'No se pudieron guardar — inténtalo de nuevo.'), { kind: 'error' });
        } finally {
            setSavingTip(false);
        }
    };
    const loadTipRange = async () => {
        if (loadingTips || !tipFrom || !tipTo) return;
        setLoadingTips(true);
        try {
            const lo = tipFrom <= tipTo ? tipFrom : tipTo;
            const hi = tipFrom <= tipTo ? tipTo : tipFrom;
            setTipRows(await getCashTipsRange({ from: lo, to: hi }));
            setLoadedRange({ from: lo, to: hi });
        } catch (e) {
            console.warn('cash tips range failed:', e);
            toast(tx('Could not load tips.', 'No se pudieron cargar las propinas.'), { kind: 'error' });
            setTipRows([]);
        } finally {
            setLoadingTips(false);
        }
    };
    // Edit a saved tip (corrections) — logged on the doc (`edits[]`), then reload.
    const doEditTip = async (r) => {
        const newCents = dollarsToCents(editTipVal);
        if (newCents === (Number(r.amountCents) || 0)) { setEditTipId(null); return; }
        try {
            await editCashTips({ location: r.location, date: r.date, newAmountCents: newCents, by: staffName });
            toast(tx(`Tip updated · ${fmtMoney(newCents)}`, `Propina actualizada · ${fmtMoney(newCents)}`), { kind: 'success' });
            setEditTipId(null);
            await loadTipRange();
        } catch (e) {
            console.warn('cash tip edit failed:', e);
            toast(tx('Could not update — try again.', 'No se pudo actualizar — inténtalo de nuevo.'), { kind: 'error' });
        }
    };
    const tipFiltered = useMemo(() => {
        if (!Array.isArray(tipRows)) return [];
        const rows = locFilter === 'all' ? tipRows : tipRows.filter((r) => r.location === locFilter);
        return [...rows].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    }, [tipRows, locFilter]);
    const tipRangeTotal = useMemo(
        () => tipFiltered.reduce((s, r) => s + (Number(r.amountCents) || 0), 0),
        [tipFiltered],
    );
    // Days in the loaded range with no tip entry (Sundays excluded — closed).
    const missingDays = useMemo(() => {
        if (tipRows === null || !loadedRange) return [];
        return missingTipDays(loadedRange.from, loadedRange.to, new Set(tipFiltered.map((r) => r.date)));
    }, [tipRows, loadedRange, tipFiltered]);

    const filtered = useMemo(() => {
        if (!Array.isArray(history)) return [];
        // History = PAST days; today's counts live in the "Today" panel and roll
        // in here automatically after midnight.
        return history.filter((h) => h.date !== today && (locFilter === 'all' || h.location === locFilter));
    }, [history, locFilter, today]);

    const locLabel = LOCATION_LABELS[storeLocation] || storeLocation;

    return (
        <div className="max-w-3xl mx-auto px-3 pb-28 pt-3 space-y-3">
            {/* Header + view toggle */}
            <div className="rounded-2xl border border-dd-green/30 bg-dd-green-50 p-4">
                <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2 min-w-0">
                        <div className="w-10 h-10 rounded-full bg-white/70 text-dd-green-700 flex items-center justify-center shrink-0">
                            <Wallet size={20} strokeWidth={2.25} />
                        </div>
                        <div className="min-w-0">
                            <h1 className="text-lg font-black text-dd-text leading-tight">{tx('Money Count', 'Conteo de Dinero')}</h1>
                            <p className="text-[11px] text-dd-text-2 truncate">{locLabel} · {tx('managers only', 'solo gerentes')}</p>
                        </div>
                    </div>
                    <div className="inline-flex rounded-xl bg-white/70 p-0.5 shrink-0">
                        {[['count', tx('Count', 'Contar')], ['history', tx('History', 'Historial')]].map(([k, label]) => (
                            <button key={k} onClick={() => setView(k)}
                                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition ${view === k ? 'bg-dd-green text-white shadow-sm' : 'text-dd-text-2'}`}>
                                {label}
                            </button>
                        ))}
                    </div>
                </div>
            </div>

            {view === 'count' ? (
                <>
                    {/* Coins (left) + Bills (right) */}
                    <div className="grid grid-cols-2 gap-3">
                        <Column title={tx('Coins', 'Monedas')} Icon={Coins} denoms={COIN_DENOMS} counts={counts} setCount={setCount} isEn={isEn} />
                        <Column title={tx('Bills', 'Billetes')} Icon={Banknote} denoms={BILL_DENOMS} counts={counts} setCount={setCount} isEn={isEn} />
                    </div>

                    {/* Drawer total + actions */}
                    <div className="rounded-2xl border border-dd-line bg-white shadow-card p-3 flex items-center gap-3">
                        <div className="min-w-0 flex-1">
                            <div className="text-[10px] font-bold uppercase tracking-wider text-dd-text-2">{tx('Drawer total', 'Total de caja')}</div>
                            <div className="text-2xl font-black text-dd-green-700 tabular-nums leading-none">{fmtMoney(total)}</div>
                        </div>
                        <button onClick={clearAll} disabled={!hasEntries}
                            className="inline-flex items-center gap-1 px-3 py-2.5 rounded-xl text-sm font-bold text-dd-text-2 bg-dd-bg border border-dd-line disabled:opacity-40 active:scale-95">
                            <Eraser size={15} /> {tx('Clear', 'Borrar')}
                        </button>
                        <button onClick={save} disabled={saving || !hasEntries}
                            className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl text-sm font-black text-white bg-dd-green disabled:opacity-40 active:scale-95 shadow-sm">
                            <Save size={15} strokeWidth={2.5} /> {saving ? tx('Saving…', 'Guardando…') : tx('Save count', 'Guardar')}
                        </button>
                    </div>

                    {/* Today's counts — morning, mid, night… saved through the day.
                        Rolls into History automatically after midnight. */}
                    {todayCounts.length > 0 && (
                        <div className="rounded-2xl border border-dd-green/20 bg-dd-green-50/40 p-3">
                            <div className="flex items-center justify-between mb-1.5">
                                <span className="text-[11px] font-black uppercase tracking-wider text-dd-green-700">📋 {tx("Today's counts", 'Conteos de hoy')}</span>
                                <span className="text-[11px] font-bold text-dd-text-2">{todayCounts.length} {tx('saved', 'guardados')}</span>
                            </div>
                            <ul className="space-y-1">
                                {todayCounts.map((h, i) => (
                                    <li key={h.id} className="flex items-center justify-between text-sm px-2.5 py-1.5 rounded-lg bg-white border border-dd-line">
                                        <span className="font-bold text-dd-text tabular-nums">{fmtMoney(h.totalCents)}</span>
                                        <span className="text-[11px] text-dd-text-2">{i === 0 ? `${tx('1st', '1°')} · ` : ''}{fmtWhen(h.createdMs, isEn)}</span>
                                    </li>
                                ))}
                            </ul>
                            <p className="text-[10px] text-dd-text-2 mt-1.5">{tx('Saved counts for today — they move to History after midnight.', 'Conteos de hoy — pasan al Historial después de medianoche.')}</p>
                        </div>
                    )}

                    {/* ── Cash tips — a SEPARATE daily total, saved on its own ── */}
                    <div className="rounded-2xl border border-amber-200 bg-amber-50/60 p-4">
                        <div className="flex items-center gap-1.5 mb-2 text-[11px] font-black uppercase tracking-wider text-amber-800">
                            <HandCoins size={14} strokeWidth={2.5} />
                            {tx("Cash tips", 'Propinas en efectivo')}
                        </div>
                        <p className="text-[11px] text-dd-text-2 mb-2">{tx("The day's cash tips — saved separately from the drawer count. Re-saving a day updates that day's total.", 'Las propinas del día — guardadas aparte del conteo de caja. Volver a guardar un día actualiza su total.')}</p>
                        <div className="flex items-end gap-2 flex-wrap">
                            <label className="flex flex-col gap-0.5">
                                <span className="text-[10px] font-bold text-dd-text-2">{tx('Date', 'Fecha')}</span>
                                <input type="date" value={tipDate} onChange={(e) => setTipDate(e.target.value)}
                                    className="px-2.5 py-2 text-base bg-white border border-dd-line rounded-lg text-dd-text focus:border-amber-400 focus:ring-1 focus:ring-amber-200 outline-none" />
                            </label>
                            <label className="flex flex-col gap-0.5 flex-1 min-w-[8rem]">
                                <span className="text-[10px] font-bold text-dd-text-2">{tx('Amount', 'Monto')}</span>
                                <div className="relative">
                                    <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-dd-text-2 text-sm">$</span>
                                    <input type="text" inputMode="decimal" value={tipAmount}
                                        onChange={(e) => setTipAmount(e.target.value.replace(/[^0-9.]/g, ''))}
                                        placeholder="0.00"
                                        className="w-full pl-6 pr-2.5 py-2 text-base bg-white border border-dd-line rounded-lg text-dd-text tabular-nums focus:border-amber-400 focus:ring-1 focus:ring-amber-200 outline-none" />
                                </div>
                            </label>
                            <button onClick={saveTip} disabled={savingTip || tipCents <= 0}
                                className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl text-sm font-black text-white bg-amber-600 disabled:opacity-40 active:scale-95 shadow-sm">
                                <Save size={15} strokeWidth={2.5} /> {savingTip ? tx('Saving…', 'Guardando…') : tx('Save tips', 'Guardar')}
                            </button>
                        </div>
                    </div>
                </>
            ) : (
                <div className="space-y-2">
                    {/* Counts | Tips sub-toggle */}
                    <div className="inline-flex rounded-xl bg-dd-bg p-0.5">
                        {[['counts', tx('Cash counts', 'Conteos')], ['tips', tx('Tips', 'Propinas')]].map(([k, label]) => (
                            <button key={k} onClick={() => setHistMode(k)}
                                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition ${histMode === k ? 'bg-white text-dd-text shadow-sm' : 'text-dd-text-2'}`}>
                                {label}
                            </button>
                        ))}
                    </div>
                    {/* Location filter (applies to both) */}
                    <div className="flex items-center gap-1.5">
                        {[['all', tx('All', 'Todas')], ['webster', LOCATION_LABELS.webster], ['maryland', LOCATION_LABELS.maryland]].map(([k, label]) => (
                            <button key={k} onClick={() => setLocFilter(k)}
                                className={`px-2.5 py-1 rounded-full text-[11px] font-bold border transition ${locFilter === k ? 'bg-dd-green text-white border-dd-green' : 'bg-white text-dd-text-2 border-dd-line'}`}>
                                {label}
                            </button>
                        ))}
                    </div>

                    {histMode === 'tips' ? (
                        <div className="space-y-2">
                            {/* Date range → total */}
                            <div className="rounded-2xl border border-dd-line bg-white p-3">
                                <div className="flex items-center gap-1.5 mb-2 text-[11px] font-black uppercase tracking-wider text-dd-text-2">
                                    <CalendarRange size={13} strokeWidth={2.5} className="text-amber-700" />
                                    {tx('Tip total for a date range', 'Total de propinas por rango de fechas')}
                                </div>
                                <div className="flex items-end gap-2 flex-wrap">
                                    <label className="flex flex-col gap-0.5">
                                        <span className="text-[10px] font-bold text-dd-text-2">{tx('From', 'Desde')}</span>
                                        <input type="date" value={tipFrom} onChange={(e) => setTipFrom(e.target.value)}
                                            className="px-2.5 py-2 text-base bg-white border border-dd-line rounded-lg text-dd-text focus:border-amber-400 outline-none" />
                                    </label>
                                    <label className="flex flex-col gap-0.5">
                                        <span className="text-[10px] font-bold text-dd-text-2">{tx('To', 'Hasta')}</span>
                                        <input type="date" value={tipTo} onChange={(e) => setTipTo(e.target.value)}
                                            className="px-2.5 py-2 text-base bg-white border border-dd-line rounded-lg text-dd-text focus:border-amber-400 outline-none" />
                                    </label>
                                    <button onClick={loadTipRange} disabled={loadingTips}
                                        className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl text-sm font-black text-white bg-amber-600 disabled:opacity-50 active:scale-95 shadow-sm">
                                        {loadingTips ? tx('Loading…', 'Cargando…') : tx('Get total', 'Ver total')}
                                    </button>
                                </div>
                            </div>

                            {tipRows === null ? (
                                <p className="text-center text-sm text-dd-text-2 py-6">{tx('Pick a date range and tap “Get total”.', 'Elige un rango y toca “Ver total”.')}</p>
                            ) : (
                                <>
                                    <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-center">
                                        <div className="text-[10px] font-bold uppercase tracking-wider text-amber-800">{tx('Total tips', 'Total de propinas')}</div>
                                        <div className="text-3xl font-black text-amber-700 tabular-nums leading-none mt-0.5">{fmtMoney(tipRangeTotal)}</div>
                                        <div className="text-[11px] text-dd-text-2 mt-1">{loadedRange?.from} → {loadedRange?.to} · {tipFiltered.length} {tx('days with tips', 'días con propinas')}</div>
                                    </div>
                                    {missingDays.length > 0 && (
                                        <div className="rounded-xl border border-red-200 bg-red-50 p-3">
                                            <div className="text-[11px] font-black uppercase tracking-wider text-red-700 mb-1">⚠ {missingDays.length} {tx('day(s) with no tips entered', 'día(s) sin propinas')}</div>
                                            <div className="flex flex-wrap gap-1">
                                                {missingDays.map((d) => (
                                                    <span key={d} className="px-1.5 py-0.5 rounded bg-white border border-red-200 text-[11px] font-bold text-red-700 tabular-nums">{d}</span>
                                                ))}
                                            </div>
                                            <p className="text-[10px] text-red-700/70 mt-1">{tx('Sundays are excluded (closed).', 'Los domingos no cuentan (cerrado).')}</p>
                                        </div>
                                    )}
                                    {tipFiltered.length === 0 ? (
                                        <p className="text-center text-sm text-dd-text-2 py-4">{tx('No tips entered in this range.', 'No hay propinas en este rango.')}</p>
                                    ) : (
                                        <ul className="space-y-1">
                                            {tipFiltered.map((r) => {
                                                const editing = editTipId === r.id;
                                                const edits = Array.isArray(r.edits) ? r.edits : [];
                                                return (
                                                    <li key={r.id} className="rounded-lg border border-dd-line bg-white overflow-hidden">
                                                        <div className="flex items-center justify-between gap-2 px-3 py-2">
                                                            <div className="min-w-0">
                                                                <span className="text-sm font-bold text-dd-text tabular-nums">{fmtMoney(r.amountCents)}</span>
                                                                <span className="ml-2 text-[11px] text-dd-text-2">{r.date} · {r.staffName || '—'}</span>
                                                                {edits.length > 0 && <span className="ml-1 text-[10px] font-bold text-amber-700">✎{edits.length}</span>}
                                                            </div>
                                                            <div className="flex items-center gap-1 shrink-0">
                                                                <span className="px-1.5 py-0.5 rounded-full bg-dd-bg border border-dd-line text-[9px] font-bold text-dd-text-2">{LOCATION_LABELS[r.location] || r.location}</span>
                                                                <button onClick={() => { setEditTipId(editing ? null : r.id); setEditTipVal(((Number(r.amountCents) || 0) / 100).toFixed(2)); }}
                                                                    className="text-[11px] font-bold text-dd-green-700 px-2 py-1 rounded-lg hover:bg-dd-bg active:scale-95">
                                                                    {editing ? tx('Close', 'Cerrar') : tx('Edit', 'Editar')}
                                                                </button>
                                                            </div>
                                                        </div>
                                                        {editing && (
                                                            <div className="px-3 pb-3 pt-2 border-t border-dd-line/60 space-y-2 bg-dd-bg/30">
                                                                <div className="flex items-end gap-2">
                                                                    <div className="relative flex-1">
                                                                        <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-dd-text-2 text-sm">$</span>
                                                                        <input type="text" inputMode="decimal" value={editTipVal} autoFocus
                                                                            onChange={(e) => setEditTipVal(e.target.value.replace(/[^0-9.]/g, ''))}
                                                                            className="w-full pl-6 pr-2.5 py-2 text-base bg-white border border-dd-line rounded-lg text-dd-text tabular-nums focus:border-dd-green outline-none" />
                                                                    </div>
                                                                    <button onClick={() => doEditTip(r)}
                                                                        className="inline-flex items-center gap-1 px-3 py-2 rounded-lg text-sm font-black text-white bg-dd-green active:scale-95">
                                                                        <Save size={14} strokeWidth={2.5} /> {tx('Save', 'Guardar')}
                                                                    </button>
                                                                </div>
                                                                {edits.length > 0 && (
                                                                    <div className="text-[11px] text-dd-text-2">
                                                                        <div className="font-bold uppercase tracking-wider text-[10px] mb-0.5">{tx('Edit log', 'Registro de cambios')}</div>
                                                                        {[...edits].reverse().map((e, i) => (
                                                                            <div key={i} className="tabular-nums">{fmtMoney(e.oldCents)} → {fmtMoney(e.newCents)} · {e.by || '—'} · {fmtWhen(Date.parse(e.at), isEn)}</div>
                                                                        ))}
                                                                    </div>
                                                                )}
                                                            </div>
                                                        )}
                                                    </li>
                                                );
                                            })}
                                        </ul>
                                    )}
                                </>
                            )}
                        </div>
                    ) : history === null ? (
                        <p className="text-center text-sm text-dd-text-2 py-8">{tx('Loading…', 'Cargando…')}</p>
                    ) : filtered.length === 0 ? (
                        <div className="rounded-2xl border border-dd-line bg-white p-8 text-center">
                            <History size={28} className="mx-auto text-dd-text-2/50 mb-2" />
                            <p className="text-sm text-dd-text-2">{tx('No counts saved yet.', 'Aún no hay conteos guardados.')}</p>
                        </div>
                    ) : (
                        <ul className="space-y-2">
                            {filtered.map((h) => {
                                const open = openId === h.id;
                                return (
                                    <li key={h.id} className="rounded-2xl border border-dd-line bg-white overflow-hidden">
                                        <button onClick={() => setOpenId(open ? null : h.id)}
                                            className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left hover:bg-dd-bg/50 active:scale-[0.998] transition">
                                            <div className="min-w-0">
                                                <div className="text-base font-black text-dd-green-700 tabular-nums">{fmtMoney(h.totalCents)}</div>
                                                <div className="text-[11px] text-dd-text-2 truncate">
                                                    {h.staffName || '—'} · {fmtWhen(h.createdMs, isEn)}
                                                    <span className="ml-1 px-1.5 py-0.5 rounded-full bg-dd-bg border border-dd-line text-[9px] font-bold">{LOCATION_LABELS[h.location] || h.location}</span>
                                                </div>
                                            </div>
                                            <ChevronDown size={16} className={`shrink-0 text-dd-text-2 transition-transform ${open ? 'rotate-180' : ''}`} />
                                        </button>
                                        {open && (
                                            <div className="px-4 pb-3 pt-1 border-t border-dd-line/60 grid grid-cols-2 gap-x-4 gap-y-0.5">
                                                {[...COIN_DENOMS, ...BILL_DENOMS].map((d) => {
                                                    const n = Number(h.counts?.[d.cents]) || 0;
                                                    if (!n) return null;
                                                    return (
                                                        <div key={d.cents} className="flex items-center justify-between text-[12px] py-0.5">
                                                            <span className="text-dd-text-2">{d.label} × {n}</span>
                                                            <span className="font-bold text-dd-text tabular-nums">{fmtMoney(d.cents * n)}</span>
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        )}
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </div>
            )}
        </div>
    );
}
