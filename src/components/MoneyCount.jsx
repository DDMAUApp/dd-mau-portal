// MoneyCount — manager cash-drawer counter (Andrew 2026-06-25).
//
// Enter how many of each coin/bill → penny-exact running total → Save. Coins on
// the LEFT, bills on the RIGHT. A History view lists every past save with its
// timestamp + who counted it. Manager-gated (canCountMoney). All math in
// integer cents (src/data/moneyCount.js) so a drawer of pennies never drifts.

import { useState, useEffect, useMemo } from 'react';
import { Coins, Banknote, History, Save, Eraser, ChevronDown, Wallet } from 'lucide-react';
import { toast } from '../toast';
import {
    COIN_DENOMS, BILL_DENOMS, totalCents, fmtMoney, saveMoneyCount, subscribeMoneyCounts,
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
        <div className="flex items-center gap-2 py-1.5">
            <span className="w-12 shrink-0 text-sm font-black text-dd-text tabular-nums">{denom.label}</span>
            <input
                type="number" inputMode="numeric" min="0" step="1"
                value={value}
                onChange={(e) => onChange(e.target.value)}
                onFocus={(e) => e.target.select()}
                placeholder="0"
                aria-label={`${denom.label} ${isEn ? 'count' : 'cantidad'}`}
                className="w-full min-w-0 px-2.5 py-2 text-base text-dd-text bg-white border border-dd-line rounded-lg text-center tabular-nums focus:border-dd-green focus:ring-1 focus:ring-dd-green-50 outline-none"
            />
            <span className="w-16 shrink-0 text-right text-[12px] font-bold text-dd-text-2 tabular-nums">
                {n > 0 ? fmtMoney(denom.cents * n) : ''}
            </span>
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

    // Resolve the counter's id (App may or may not pass it).
    const myId = staffId ?? (staffList || []).find((s) => s?.name === staffName)?.id ?? null;

    const total = useMemo(() => totalCents(
        Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, Number(v) || 0])),
    ), [counts]);
    const hasEntries = total > 0;

    useEffect(() => {
        if (view !== 'history') return;
        const unsub = subscribeMoneyCounts(setHistory);
        return () => unsub();
    }, [view]);

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

    const filtered = useMemo(() => {
        if (!Array.isArray(history)) return [];
        return locFilter === 'all' ? history : history.filter((h) => h.location === locFilter);
    }, [history, locFilter]);

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

                    {/* Sticky total + actions */}
                    <div className="sticky bottom-3 z-10">
                        <div className="rounded-2xl border border-dd-line bg-white shadow-card p-3 flex items-center gap-3">
                            <div className="min-w-0 flex-1">
                                <div className="text-[10px] font-bold uppercase tracking-wider text-dd-text-2">{tx('Total', 'Total')}</div>
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
                    </div>
                </>
            ) : (
                <div className="space-y-2">
                    {/* Location filter */}
                    <div className="flex items-center gap-1.5">
                        {[['all', tx('All', 'Todas')], ['webster', LOCATION_LABELS.webster], ['maryland', LOCATION_LABELS.maryland]].map(([k, label]) => (
                            <button key={k} onClick={() => setLocFilter(k)}
                                className={`px-2.5 py-1 rounded-full text-[11px] font-bold border transition ${locFilter === k ? 'bg-dd-green text-white border-dd-green' : 'bg-white text-dd-text-2 border-dd-line'}`}>
                                {label}
                            </button>
                        ))}
                    </div>

                    {history === null ? (
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
