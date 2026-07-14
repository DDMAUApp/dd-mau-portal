// MoneyCount — manager cash-drawer counter (Andrew 2026-06-25).
//
// Enter how many of each coin/bill → penny-exact running total → Save. Coins on
// the LEFT, bills on the RIGHT. A History view lists every past save with its
// timestamp + who counted it. Manager-gated (canCountMoney). All math in
// integer cents (src/data/moneyCount.js) so a drawer of pennies never drifts.

import { useState, useEffect, useMemo, useCallback, useRef, memo } from 'react';
import { Coins, Banknote, History, Save, Eraser, ChevronDown, Wallet, HandCoins, CalendarRange, Trash2, StickyNote } from 'lucide-react';
import { toast } from '../toast';
import {
    COIN_DENOMS, BILL_DENOMS, totalCents, fmtMoney, saveMoneyCount, subscribeMoneyCounts, subscribeTodayCounts,
    centralDate, dollarsToCents, saveCashTips, getCashTipsRange, editCashTips, missingTipDays,
    deleteMoneyCount, setMoneyCountNote,
} from '../data/moneyCount';
import { recordAudit } from '../data/audit';
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

// Time-of-day only (Central), e.g. "8:12 PM". Used on tip-history rows so a
// manager can see WHEN each cash-tip total was entered, not just the day.
function fmtTime(ms, isEn) {
    if (!ms) return '';
    try {
        return new Date(ms).toLocaleTimeString(isEn ? 'en-US' : 'es-US', {
            timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit',
        });
    } catch { return ''; }
}

// One denomination row: label · count input · row subtotal. Memoized + given a
// STABLE setCount, so typing in one row re-renders only that row — the other
// denominations bail out (their value is unchanged), keeping input snappy.
const DenomRow = memo(function DenomRow({ denom, value, setCount, isEn }) {
    const n = Math.max(0, Math.floor(Number(value) || 0));
    return (
        <div className="py-1.5">
            <div className="flex items-center gap-2">
                <span className="w-9 shrink-0 text-sm font-black text-dd-text tabular-nums">{denom.label}</span>
                <input
                    type="number" inputMode="numeric" min="0" step="1"
                    value={value}
                    onChange={(e) => setCount(denom.cents, e.target.value)}
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
});

function Column({ title, Icon, denoms, counts, setCount, isEn }) {
    return (
        <div className="rounded-2xl border border-dd-line bg-white p-3">
            <div className="flex items-center gap-1.5 mb-1 text-[11px] font-black uppercase tracking-wider text-dd-text-2">
                <Icon size={13} strokeWidth={2.5} className="text-dd-green-700" />
                {title}
            </div>
            <div className="divide-y divide-dd-line/50">
                {denoms.map((d) => (
                    <DenomRow key={d.cents} denom={d} value={counts[d.cents] ?? ''} setCount={setCount} isEn={isEn} />
                ))}
            </div>
        </div>
    );
}

export default function MoneyCount({ language, storeLocation, staffName, staffList, staffId }) {
    const isEn = language !== 'es';
    const tx = (en, es) => (isEn ? en : es);
    const [view, setView] = useState('count');     // 'count' | 'history'
    // Live draft persistence (Andrew 2026-07-14: "keep the count live so
    // if they leave it stays there"). The in-progress count is mirrored to
    // localStorage, keyed per store, so switching tabs, a relock, or a
    // reload never loses a half-counted drawer — it rehydrates exactly
    // where they left off, and clears itself the moment they Save or Clear.
    const draftKey = (l) => 'ddmau:moneydraft:' + l;
    const STORE_MEMORY_KEY = 'ddmau:moneydraft:store';
    const readStoreMemory = () => {
        try { const s = localStorage.getItem(STORE_MEMORY_KEY); return (s === 'maryland' || s === 'webster') ? s : null; } catch { return null; }
    };
    const [counts, setCounts] = useState(() => {       // { [cents]: 'string' }
        // For a fixed-store manager use their store; for a 'both'/admin
        // manager restore the store they last counted so an in-progress
        // Maryland draft isn't hidden behind the Webster default on return.
        const initLoc = (storeLocation === 'webster' || storeLocation === 'maryland')
            ? storeLocation : (readStoreMemory() || 'webster');
        try {
            const raw = localStorage.getItem(draftKey(initLoc));
            if (raw) { const d = JSON.parse(raw); if (d && typeof d === 'object') return d; }
        } catch { /* private mode / bad JSON → fresh */ }
        return {};
    });
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
    const [savingEdit, setSavingEdit] = useState(false);    // in-flight guard for a tip edit
    const [todayRaw, setTodayRaw] = useState([]);           // live, today-only counts (both stores)
    // Guards setState-after-await: the page is conditionally rendered, so a tab
    // switch can unmount it mid-save.
    const mountedRef = useRef(true);
    useEffect(() => () => { mountedRef.current = false; }, []);
    // The store being counted. A single-store manager (or an admin with a
    // concrete active location) is locked to it; a 'both'/unknown manager must
    // PICK — never let 'both' reach a save (it isn't a real store and would be
    // invisible under the webster/maryland filters).
    const fixedStore = (storeLocation === 'webster' || storeLocation === 'maryland') ? storeLocation : null;
    // 'both' managers resume the store they last counted (see counts init).
    const [pickedStore, setPickedStore] = useState(() => readStoreMemory() || 'webster');
    const loc = fixedStore || pickedStore;
    // Remember the active store so a remount restores the right draft.
    useEffect(() => { try { localStorage.setItem(STORE_MEMORY_KEY, loc); } catch { /* private mode */ } }, [loc]);
    // Draft ↔ store binding. Persist every change under the CURRENT store's
    // key; when a 'both' manager toggles stores, swap in that store's own
    // saved draft (each store keeps its own in-progress count).
    const locRef = useRef(loc);
    useEffect(() => {
        if (locRef.current === loc) return;   // first mount (lazy-init already loaded) / no change
        locRef.current = loc;
        try {
            const raw = localStorage.getItem(draftKey(loc));
            setCounts(raw ? (JSON.parse(raw) || {}) : {});
        } catch { setCounts({}); }
    }, [loc]);
    // Write the draft synchronously (see setCount) AND on unmount as a
    // backstop — never rely on a deferred effect that might not flush before
    // the screen is torn down. This effect only mirrors current state on the
    // rare programmatic setCounts (store swap / clearAll).
    const writeDraft = (obj) => {
        try {
            if (obj && Object.keys(obj).length) localStorage.setItem(draftKey(locRef.current), JSON.stringify(obj));
            else localStorage.removeItem(draftKey(locRef.current));
        } catch { /* private mode → draft simply won't persist */ }
    };
    const countsRef = useRef(counts);
    useEffect(() => { countsRef.current = counts; writeDraft(counts); }, [counts]);
    // Persist the latest count when the screen is left (tab switch unmounts
    // this component) — the direct fix for "click out and the count resets."
    useEffect(() => () => { writeDraft(countsRef.current); }, []);
    // `today` (Central) in state + a 1-min timer + visibility re-check, so a
    // screen left open on a shared iPad rolls past midnight without waiting for
    // an incidental render (Today panel ↔ History split stays correct).
    const [today, setToday] = useState(() => centralDate());
    useEffect(() => {
        const tick = () => setToday((t) => { const n = centralDate(); return n === t ? t : n; });
        const id = setInterval(tick, 60_000);
        document.addEventListener('visibilitychange', tick);
        return () => { clearInterval(id); document.removeEventListener('visibilitychange', tick); };
    }, []);

    // Resolve the counter's id (App may or may not pass it).
    const myId = staffId ?? (staffList || []).find((s) => s?.name === staffName)?.id ?? null;

    const total = useMemo(() => totalCents(
        Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, Number(v) || 0])),
    ), [counts]);
    const hasEntries = total > 0;

    // History list (past days) — the heavier 300-doc listener. Held open ONLY
    // while the History view is showing, so the hot Count screen stays light.
    useEffect(() => {
        if (view !== 'history') return undefined;
        const unsub = subscribeMoneyCounts(setHistory);
        return () => unsub();
    }, [view]);

    // Today's counts stream on their own tiny `date == today` listener (both
    // stores), re-keyed when the date rolls past midnight. Filtered to THIS store
    // for the panel; past days fall out of this query on their own → History.
    useEffect(() => {
        const unsub = subscribeTodayCounts(today, setTodayRaw);
        return () => unsub();
    }, [today]);
    const todayCounts = useMemo(() => (
        (Array.isArray(todayRaw) ? todayRaw : [])
            .filter((h) => h.location === loc)
            .sort((a, b) => (a.createdMs || 0) - (b.createdMs || 0))
    ), [todayRaw, loc]);

    // Stable identity so memoized DenomRows don't re-render on every keystroke.
    const setCount = useCallback((cents, v) => {
        const clean = String(v).replace(/[^\d]/g, '');   // digits only, allow empty
        setCounts((c) => {
            const next = { ...c, [cents]: clean };
            // Persist THIS keystroke synchronously so leaving the screen the
            // instant after typing can't lose it (no wait for a passive effect).
            try {
                if (Object.keys(next).length) localStorage.setItem(draftKey(locRef.current), JSON.stringify(next));
                else localStorage.removeItem(draftKey(locRef.current));
            } catch { /* private mode */ }
            return next;
        });
    }, []);

    const clearAll = () => { setCounts({}); setOpenId(null); };

    // ── Saved-count row actions (Andrew 2026-07-14): delete a wrong count
    //    (then re-count) or leave a note on one that's just missing info ──
    const [noteDrafts, setNoteDrafts] = useState({});   // { [id]: text }
    const [confirmDelId, setConfirmDelId] = useState(null);
    const [rowBusy, setRowBusy] = useState(null);       // id being saved/deleted
    const saveNote = async (h) => {
        if (rowBusy) return;
        const text = (noteDrafts[h.id] ?? h.note ?? '').trim();
        setRowBusy(h.id);
        try {
            await setMoneyCountNote({ id: h.id, note: text, by: staffName });
            toast(text ? tx('Note saved', 'Nota guardada') : tx('Note cleared', 'Nota eliminada'), { kind: 'success' });
            // Drop the local draft so the input follows the live doc value.
            setNoteDrafts((m) => { const n = { ...m }; delete n[h.id]; return n; });
        } catch (e) {
            console.warn('money count note save failed:', e);
            toast(tx('Could not save note — try again.', 'No se pudo guardar la nota.'), { kind: 'error' });
        } finally { if (mountedRef.current) setRowBusy(null); }
    };
    const doDelete = async (h) => {
        if (rowBusy) return;
        setRowBusy(h.id);
        try {
            await deleteMoneyCount(h.id);
            // Financial record — log who deleted what (recoverable from backups).
            recordAudit({ action: 'money_count.deleted', actorName: staffName, actorId: myId, targetType: 'money_count', targetId: h.id, details: { totalCents: h.totalCents, date: h.date, location: h.location } });
            toast(tx('Count deleted', 'Conteo eliminado'), { kind: 'success' });
            if (openId === h.id) setOpenId(null);
        } catch (e) {
            console.warn('money count delete failed:', e);
            toast(tx('Could not delete — try again.', 'No se pudo eliminar.'), { kind: 'error' });
        } finally { if (mountedRef.current) { setRowBusy(null); setConfirmDelId(null); } }
    };

    const save = async () => {
        if (saving || !hasEntries) return;
        setSaving(true);
        try {
            await saveMoneyCount({ counts, staffName, staffId: myId, location: loc });
            toast(tx(`Saved · ${fmtMoney(total)}`, `Guardado · ${fmtMoney(total)}`), { kind: 'success' });
            if (mountedRef.current) clearAll();
        } catch (e) {
            console.warn('money count save failed:', e);
            toast(tx('Could not save — try again.', 'No se pudo guardar — inténtalo de nuevo.'), { kind: 'error' });
        } finally {
            if (mountedRef.current) setSaving(false);
        }
    };

    // ── Cash tips ──
    const tipCents = dollarsToCents(tipAmount);
    const saveTip = async () => {
        if (savingTip || tipCents <= 0 || !tipDate) return;
        setSavingTip(true);
        try {
            await saveCashTips({ date: tipDate, amountCents: tipCents, staffName, staffId: myId, location: loc });
            toast(tx(`Tips saved · ${fmtMoney(tipCents)}`, `Propinas guardadas · ${fmtMoney(tipCents)}`), { kind: 'success' });
            if (mountedRef.current) setTipAmount('');
        } catch (e) {
            console.warn('cash tips save failed:', e);
            toast(tx('Could not save tips — try again.', 'No se pudieron guardar — inténtalo de nuevo.'), { kind: 'error' });
        } finally {
            if (mountedRef.current) setSavingTip(false);
        }
    };
    const loadTipRange = async () => {
        if (loadingTips || !tipFrom || !tipTo) return;
        setLoadingTips(true);
        try {
            const lo = tipFrom <= tipTo ? tipFrom : tipTo;
            const hi = tipFrom <= tipTo ? tipTo : tipFrom;
            const rows = await getCashTipsRange({ from: lo, to: hi });
            if (!mountedRef.current) return;
            setTipRows(rows);
            setLoadedRange({ from: lo, to: hi });
        } catch (e) {
            console.warn('cash tips range failed:', e);
            if (mountedRef.current) {
                toast(tx('Could not load tips.', 'No se pudieron cargar las propinas.'), { kind: 'error' });
                setTipRows([]);
            }
        } finally {
            if (mountedRef.current) setLoadingTips(false);
        }
    };
    // Edit a saved tip (corrections) — logged on the doc (`edits[]`), then reload.
    const doEditTip = async (r) => {
        if (savingEdit) return;   // no double-tap → no duplicate edit-log entry
        const newCents = dollarsToCents(editTipVal);
        if (newCents === (Number(r.amountCents) || 0)) { setEditTipId(null); return; }
        setSavingEdit(true);
        try {
            await editCashTips({ location: r.location, date: r.date, newAmountCents: newCents, by: staffName });
            toast(tx(`Tip updated · ${fmtMoney(newCents)}`, `Propina actualizada · ${fmtMoney(newCents)}`), { kind: 'success' });
            if (mountedRef.current) setEditTipId(null);
            await loadTipRange();
        } catch (e) {
            console.warn('cash tip edit failed:', e);
            if (mountedRef.current) toast(tx('Could not update — try again.', 'No se pudo actualizar — inténtalo de nuevo.'), { kind: 'error' });
        } finally {
            if (mountedRef.current) setSavingEdit(false);
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
    // Per-location subtotals — so the "All" view never reads as one merged blob;
    // each store's tips stay visibly separate.
    const tipByLocation = useMemo(() => {
        const m = {};
        for (const r of tipFiltered) {
            const k = r.location || 'unknown';
            m[k] = (m[k] || 0) + (Number(r.amountCents) || 0);
        }
        return Object.entries(m).sort((a, b) => b[1] - a[1]);
    }, [tipFiltered]);
    // Distinct days that have a tip (built once, reused for the count label + the
    // missing-day check instead of rebuilding a Set inline in JSX each render).
    const daysWithTips = useMemo(() => new Set(tipFiltered.map((r) => r.date)), [tipFiltered]);
    // Days in the loaded range with no tip entry (Sundays excluded — closed).
    const missingDays = useMemo(() => {
        if (tipRows === null || !loadedRange) return [];
        return missingTipDays(loadedRange.from, loadedRange.to, daysWithTips);
    }, [tipRows, loadedRange, daysWithTips]);

    const filtered = useMemo(() => {
        if (!Array.isArray(history)) return [];
        // History = PAST days; today's counts live in the "Today" panel and roll
        // in here automatically after midnight.
        return history.filter((h) => h.date !== today && (locFilter === 'all' || h.location === locFilter));
    }, [history, locFilter, today]);

    const locLabel = LOCATION_LABELS[loc] || loc;

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
                {/* Store picker — only when the manager isn't locked to one store
                    (e.g. covers "both"). Forces a real store before any save. */}
                {!fixedStore && (
                    <div className="mt-3 flex items-center gap-2">
                        <span className="text-[11px] font-bold text-dd-text-2">{tx('Counting at:', 'Contando en:')}</span>
                        {['webster', 'maryland'].map((s) => (
                            <button key={s} onClick={() => setPickedStore(s)}
                                className={`px-3 py-1.5 rounded-lg text-xs font-bold border transition ${loc === s ? 'bg-dd-green text-white border-dd-green' : 'bg-white text-dd-text-2 border-dd-line'}`}>
                                {LOCATION_LABELS[s]}
                            </button>
                        ))}
                    </div>
                )}
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
                            {/* key changes with the value so iOS WKWebView is forced to repaint
                                this node — without it the total renders garbled/clipped while the
                                soft keyboard is open (it only repaints on keyboard dismiss). */}
                            <div key={total} className="text-2xl font-black text-dd-green-700 tabular-nums leading-tight py-0.5">{fmtMoney(total)}</div>
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
                                {todayCounts.map((h, i) => {
                                    const open = openId === h.id;
                                    return (
                                        <li key={h.id} className="rounded-lg bg-white border border-dd-line overflow-hidden">
                                            {/* Tap a count to see its coin/bill breakdown (same as History). */}
                                            <button onClick={() => setOpenId(open ? null : h.id)}
                                                className="w-full flex items-center justify-between gap-2 text-sm px-2.5 py-1.5 text-left hover:bg-dd-bg/40 active:scale-[0.998] transition">
                                                <span className="font-bold text-dd-text tabular-nums">{fmtMoney(h.totalCents)}</span>
                                                <span className="flex items-center gap-1.5 text-[11px] text-dd-text-2">
                                                    {h.note ? <StickyNote size={11} className="text-amber-600 shrink-0" /> : null}
                                                    {i === 0 ? `${tx('1st', '1°')} · ` : ''}{fmtWhen(h.createdMs, isEn)}
                                                    <ChevronDown size={14} className={`shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
                                                </span>
                                            </button>
                                            {open && (
                                                <>
                                                <div className="px-2.5 pb-2 pt-1 border-t border-dd-line/60 grid grid-cols-2 gap-x-4 gap-y-0.5">
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
                                                {/* Note + delete (Andrew 2026-07-14) */}
                                                <div className="px-2.5 pb-2.5 pt-1.5 border-t border-dd-line/60 space-y-2">
                                                    {h.staffName && <p className="text-[10px] text-dd-text-2">{tx('Counted by', 'Contado por')} <b>{h.staffName}</b></p>}
                                                    <div className="flex items-end gap-1.5">
                                                        <label className="flex-1 flex flex-col gap-0.5 min-w-0">
                                                            <span className="text-[10px] font-bold text-dd-text-2 flex items-center gap-1"><StickyNote size={11} /> {tx('Note', 'Nota')}</span>
                                                            <input value={noteDrafts[h.id] ?? (h.note || '')}
                                                                onChange={(e) => setNoteDrafts((m) => ({ ...m, [h.id]: e.target.value }))}
                                                                placeholder={tx('e.g. drawer short $5, waiting on a void', 'ej. faltan $5, esperando un anulado')}
                                                                maxLength={500}
                                                                className="px-2.5 py-2 text-base bg-white border border-dd-line rounded-lg text-dd-text focus:border-dd-green focus:ring-1 focus:ring-dd-green/20 outline-none" />
                                                        </label>
                                                        <button onClick={() => saveNote(h)}
                                                            disabled={rowBusy === h.id || (noteDrafts[h.id] ?? (h.note || '')) === (h.note || '')}
                                                            className="px-3 py-2 rounded-lg text-xs font-bold text-white bg-dd-green disabled:opacity-40 active:scale-95">
                                                            {tx('Save', 'Guardar')}
                                                        </button>
                                                    </div>
                                                    {h.note && h.noteBy && <p className="text-[10px] text-dd-text-2">📝 {tx('Note by', 'Nota de')} {h.noteBy}</p>}
                                                    {confirmDelId === h.id ? (
                                                        <div className="flex items-center gap-1.5 flex-wrap">
                                                            <span className="text-[11px] font-bold text-red-600 flex-1 min-w-[8rem]">{tx('Delete this count? It can’t be undone.', '¿Eliminar este conteo? No se puede deshacer.')}</span>
                                                            <button onClick={() => doDelete(h)} disabled={rowBusy === h.id}
                                                                className="px-3 py-1.5 rounded-lg text-xs font-black text-white bg-red-600 disabled:opacity-40 active:scale-95">
                                                                {rowBusy === h.id ? tx('Deleting…', 'Eliminando…') : tx('Yes, delete', 'Sí, eliminar')}
                                                            </button>
                                                            <button onClick={() => setConfirmDelId(null)}
                                                                className="px-3 py-1.5 rounded-lg text-xs font-bold text-dd-text-2 bg-dd-bg border border-dd-line active:scale-95">
                                                                {tx('Cancel', 'Cancelar')}
                                                            </button>
                                                        </div>
                                                    ) : (
                                                        <button onClick={() => setConfirmDelId(h.id)}
                                                            className="inline-flex items-center gap-1 text-xs font-bold text-red-600 px-2 py-1 -ml-1 rounded-lg hover:bg-red-50 active:scale-95">
                                                            <Trash2 size={13} /> {tx('Delete count', 'Eliminar conteo')}
                                                        </button>
                                                    )}
                                                </div>
                                                </>
                                            )}
                                        </li>
                                    );
                                })}
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
                                <input type="date" value={tipDate} max={today} onChange={(e) => setTipDate(e.target.value)}
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
                                        <input type="date" value={tipFrom} max={today} onChange={(e) => setTipFrom(e.target.value)}
                                            className="px-2.5 py-2 text-base bg-white border border-dd-line rounded-lg text-dd-text focus:border-amber-400 outline-none" />
                                    </label>
                                    <label className="flex flex-col gap-0.5">
                                        <span className="text-[10px] font-bold text-dd-text-2">{tx('To', 'Hasta')}</span>
                                        <input type="date" value={tipTo} max={today} onChange={(e) => setTipTo(e.target.value)}
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
                                        <div className="text-3xl font-black text-amber-700 tabular-nums leading-tight py-0.5">{fmtMoney(tipRangeTotal)}</div>
                                        <div className="text-[11px] text-dd-text-2 mt-1">{loadedRange?.from} → {loadedRange?.to} · {daysWithTips.size} {tx('days with tips', 'días con propinas')}</div>
                                        {locFilter === 'all' && tipByLocation.length > 1 && (
                                            <div className="flex items-center justify-center gap-3 mt-2 pt-2 border-t border-amber-200/70">
                                                {tipByLocation.map(([k, cents]) => (
                                                    <div key={k} className="text-center">
                                                        <div className="text-[9px] font-bold uppercase tracking-wider text-amber-800/80">{LOCATION_LABELS[k] || k}</div>
                                                        <div className="text-sm font-black text-amber-700 tabular-nums">{fmtMoney(cents)}</div>
                                                    </div>
                                                ))}
                                            </div>
                                        )}
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
                                                                <span className="ml-2 text-[11px] text-dd-text-2">{r.date}{r.updatedMs ? ` · ${fmtTime(r.updatedMs, isEn)}` : ''} · {r.staffName || '—'}</span>
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
                                                                    <button onClick={() => doEditTip(r)} disabled={savingEdit}
                                                                        className="inline-flex items-center gap-1 px-3 py-2 rounded-lg text-sm font-black text-white bg-dd-green active:scale-95 disabled:opacity-50">
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
