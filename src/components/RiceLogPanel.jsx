// RiceLogPanel — fried-rice rice cooling log + batch stickers
// (Andrew 2026-11-02, health department request). See src/data/riceLog.js
// for the clock rules and the /rice_log doc shape.
//
// Top: "Rice done cooking" → logs the batch AND prints its sticker
// (COOKED time · BATCH # · FRIDGE BY · TOSS). Below: the day's batches with
// live countdowns and one-tap outcomes (used / into fridge + temp / tossed),
// and a printable log for the inspector. Open to all staff — the cook who
// pulls the rice is the one who logs it.
import { useEffect, useMemo, useState } from 'react';
import { X, Printer, Snowflake, Trash2, CheckCircle2 } from 'lucide-react';
import ModalPortal from './ModalPortal';
import { toast } from '../toast';
import { printViaNative } from '../capacitor-bridge';
import {
    RICE_FRIDGE_BY_HOURS, RICE_TOSS_HOURS, RICE_STATUS,
    riceDayStr, riceDeadlines, nextBatchNo, riceBatchState, duplicateBatchNumbers,
    subscribeRiceLog, startRiceBatch, printRiceSticker,
    markRiceUsed, markRiceFridge, markRiceTossed, markRiceVoid,
    fmtRiceTime, riceOutcomeText, buildRiceLogHtml,
} from '../data/riceLog';

const toInputTime = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

// "1h 05m" / "12m" until (or since) a deadline.
function fmtLeft(ms) {
    const m = Math.max(0, Math.round(Math.abs(ms) / 60000));
    const h = Math.floor(m / 60);
    return h > 0 ? `${h}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`;
}

const PRINT_ERRORS = {
    no_printer_configured: ['No printer set up for this store — ask a manager.', 'No hay impresora para esta tienda — pregunta a un gerente.'],
    printer_disabled: ['The printer is turned off in settings.', 'La impresora está desactivada en la configuración.'],
    'printer timeout': ['Printer did not respond — is it on and on Wi-Fi?', 'La impresora no respondió — ¿está encendida y en Wi-Fi?'],
    printer_rejected: ['Printer rejected the sticker — check paper and cover.', 'La impresora rechazó la etiqueta — revisa el papel y la tapa.'],
};

export default function RiceLogPanel({ location = 'webster', staffName, language = 'en', onClose }) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);
    const loc = location === 'both' ? 'webster' : location;
    const locLabel = loc === 'maryland' ? 'Maryland Heights' : 'Webster Groves';

    // Live clock — countdowns + overdue states re-evaluate every 30s.
    const [now, setNow] = useState(() => new Date());
    useEffect(() => {
        const id = setInterval(() => setNow(new Date()), 30000);
        return () => clearInterval(id);
    }, []);

    const todayS = riceDayStr(now);
    const [viewDay, setViewDay] = useState(todayS);
    const viewingToday = viewDay === todayS;
    const [rows, setRows] = useState(null);
    const [loadError, setLoadError] = useState(false);
    // Today's rows stay subscribed even while viewing a past day, so the
    // next batch number is always right. Starting a batch waits a few
    // seconds for them; after that (slow / wedged connection, first batch of
    // the day) the cook can still log — a missing health-log entry is worse
    // than a repeated number, which is flagged on screen and on the log.
    const [todayRows, setTodayRows] = useState(null);
    const [todayError, setTodayError] = useState(false);
    const [todayWaitOver, setTodayWaitOver] = useState(false);

    useEffect(() => {
        setRows(null);
        setLoadError(false);
        return subscribeRiceLog(loc, viewDay, (r) => { setRows(r); setLoadError(false); }, () => { setRows([]); setLoadError(true); });
    }, [loc, viewDay]);
    useEffect(() => {
        setTodayRows(null);
        setTodayError(false);
        return subscribeRiceLog(loc, todayS, (r) => { setTodayRows(r); setTodayError(false); }, () => setTodayError(true));
    }, [loc, todayS]);
    useEffect(() => {
        setTodayWaitOver(false);
        const t = setTimeout(() => setTodayWaitOver(true), 5000);
        return () => clearTimeout(t);
    }, [loc, todayS]);
    const todayLoaded = Array.isArray(todayRows) && !todayError;
    const todayReady = todayLoaded || todayError || todayWaitOver;
    const numberUnsure = todayReady && !todayLoaded;

    // ── New batch form ────────────────────────────────────────────────
    const [cookedTime, setCookedTime] = useState(() => toInputTime(new Date()));
    const [timeTouched, setTimeTouched] = useState(false);
    // Follow the clock until the cook picks a time themselves.
    useEffect(() => { if (!timeTouched) setCookedTime(toInputTime(now)); }, [now, timeTouched]);
    const [copies, setCopies] = useState(1);
    const [starting, setStarting] = useState(false);

    const cookedAt = useMemo(() => {
        const [h, m] = String(cookedTime || '').split(':').map(Number);
        if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
        const d = new Date(now);
        d.setHours(h, m, 0, 0);
        return d;
    }, [cookedTime, now]);
    const cookedInFuture = !!cookedAt && cookedAt.getTime() > now.getTime() + 60000;
    const deadlines = cookedAt ? riceDeadlines(cookedAt) : null;
    const alreadyPastToss = !!deadlines && deadlines.tossByAt.getTime() <= now.getTime();
    const batchNo = todayReady ? nextBatchNo(todayRows || []) : null;

    const printError = (res) => {
        const msg = PRINT_ERRORS[res?.error];
        return msg ? tx(msg[0], msg[1]) : tx('Sticker did not print — tap Reprint on the batch.', 'La etiqueta no se imprimió — toca Reimprimir en el lote.');
    };

    const handleStart = async () => {
        if (starting || !todayReady || !cookedAt || cookedInFuture || alreadyPastToss) return;
        setStarting(true);
        try {
            const { res, logFailed } = await startRiceBatch({
                cookedAt, location: loc, staffName, language, batchNo, copies,
            });
            if (res.ok) {
                toast(tx(`🍚 Batch #${batchNo} logged + sticker printed`, `🍚 Lote #${batchNo} registrado + etiqueta impresa`), { kind: 'success' });
            } else if (res.error !== 'cancelled') {
                toast(`${tx(`Batch #${batchNo} logged.`, `Lote #${batchNo} registrado.`)} ${printError(res)}`, { kind: 'error', duration: 6000 });
            }
            if (logFailed) {
                toast(tx('Could not save the batch to the log — check Wi-Fi.', 'No se pudo guardar el lote — revisa el Wi-Fi.'), { kind: 'error', duration: 6000 });
            }
            setTimeTouched(false);
            setCopies(1);
        } finally {
            setStarting(false);
        }
    };

    // ── Row actions ───────────────────────────────────────────────────
    // Busy is PER BATCH: one batch's write waiting on a weak connection must
    // never freeze every other batch's buttons (the toss of an expired
    // batch has to stay one tap away).
    const [busyIds, setBusyIds] = useState(() => new Set());
    const setBusy = (id, on) => setBusyIds((prev) => {
        const next = new Set(prev);
        if (on) next.add(id); else next.delete(id);
        return next;
    });
    const [fridgeFor, setFridgeFor] = useState(null);   // row id whose temp box is open
    const [fridgeTemp, setFridgeTemp] = useState('');

    // Outcome writes are queued locally the moment they're issued (the row
    // updates right away); the server ack can take minutes offline, so the
    // UI never waits for it. A rejection (rules, bad data) rolls the local
    // change back and toasts.
    const run = (row, fn, okMsg, onQueued) => {
        if (busyIds.has(row.id)) return;
        let p;
        try { p = fn(); } catch (e) {
            console.warn('rice_log update failed:', e);
            toast(tx('Could not save — try again.', 'No se pudo guardar — intenta de nuevo.'), { kind: 'error' });
            return;
        }
        setBusy(row.id, true);
        if (okMsg) toast(okMsg, { kind: 'success', duration: 2000 });
        onQueued?.();
        Promise.resolve(p)
            .catch((e) => {
                console.warn('rice_log update failed:', e);
                toast(tx(`Batch #${row.batchNo} did not save — try again.`, `El lote #${row.batchNo} no se guardó — intenta de nuevo.`), { kind: 'error', duration: 6000 });
            })
            .finally(() => setBusy(row.id, false));
    };

    const reprint = async (row) => {
        if (busyIds.has(row.id)) return;
        setBusy(row.id, true);
        try {
            const res = await printRiceSticker({ row, location: loc, staffName, language, copies: 1 });
            if (res.ok) toast(tx('🏷 Sticker reprinted', '🏷 Etiqueta reimpresa'), { kind: 'success', duration: 2000 });
            else if (res.error !== 'cancelled') toast(printError(res), { kind: 'error', duration: 6000 });
        } finally {
            setBusy(row.id, false);
        }
    };

    const confirmFridge = (row) => {
        const t = fridgeTemp.trim();
        if (t !== '' && !Number.isFinite(Number(t))) {
            toast(tx('Enter the temperature as a number (°F).', 'Escribe la temperatura en número (°F).'), { kind: 'error' });
            return;
        }
        if (t !== '' && Number(t) > 70) {
            const ok = window.confirm(tx(
                `${t}°F is above 70°F. Rice must be 70°F or below by the fridge-by time. Log it into the fridge anyway?`,
                `${t}°F es más de 70°F. El arroz debe estar a 70°F o menos antes de refrigerar. ¿Registrar de todos modos?`,
            ));
            if (!ok) return;
        }
        run(row, () => markRiceFridge(row, staffName, t), tx('❄ Logged into the fridge', '❄ Registrado al refrigerador'),
            () => { setFridgeFor(null); setFridgeTemp(''); });
    };

    const voidBatch = (row) => {
        const ok = window.confirm(tx(
            `Void batch #${row.batchNo}? Use this only if the sticker was printed by mistake. It stays on the log, crossed out.`,
            `¿Anular el lote #${row.batchNo}? Solo si la etiqueta se imprimió por error. Queda en el registro, tachado.`,
        ));
        if (ok) run(row, () => markRiceVoid(row, staffName), tx('Batch voided', 'Lote anulado'));
    };

    const printLog = () => {
        const html = buildRiceLogHtml({ rows: rows || [], cookDay: viewDay, locationLabel: locLabel, isEs });
        if (window?.Capacitor?.isNativePlatform?.()) { printViaNative(html, 'DD Mau Rice Log'); return; }
        const w = window.open('', '_blank', 'width=900,height=1000');
        if (!w) {
            toast(tx('Pop-up blocked. Allow pop-ups for this site to print.', 'Ventana emergente bloqueada. Permite ventanas emergentes para imprimir.'));
            return;
        }
        w.document.open();
        w.document.write(html);
        w.document.close();
    };

    const openCount = (todayRows || []).filter((r) => r.status === RICE_STATUS.COOLING).length;
    // Two devices numbering at the same moment can both pick the same
    // number — flag it on screen and on the inspector log.
    const dupNumbers = duplicateBatchNumbers(rows);
    const overdueCount = (todayRows || []).filter((r) => riceBatchState(r, now) === 'tossNow').length;

    return (
        <ModalPortal onBackPress={onClose}>
            <div className="fixed inset-0 z-[80] bg-black/40 flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={onClose}>
                <div className="bg-white w-full sm:max-w-lg sm:rounded-2xl rounded-t-2xl max-h-[94vh] flex flex-col shadow-2xl" onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center gap-2 p-3 border-t-4 border-sky-500 flex-shrink-0">
                        <span className="text-2xl">🍚</span>
                        <div className="flex-1 min-w-0">
                            <h2 className="text-base font-black text-dd-text leading-tight">{tx('Fried Rice Rice Log', 'Registro de Arroz para Arroz Frito')}</h2>
                            <p className="text-[11px] text-dd-text-2">
                                {tx(`Fridge by ${RICE_FRIDGE_BY_HOURS}h after cooking · toss at ${RICE_TOSS_HOURS}h`,
                                    `Refrigerar ${RICE_FRIDGE_BY_HOURS}h después de cocinar · tirar a las ${RICE_TOSS_HOURS}h`)}
                            </p>
                        </div>
                        <button onClick={onClose} className="p-2 -m-1 text-dd-text-2 hover:text-dd-text"><X size={20} /></button>
                    </div>

                    <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
                        {/* New batch */}
                        <div className="rounded-xl border-2 border-sky-200 bg-sky-50 p-3">
                            <div className="text-sm font-black text-sky-950 mb-2">
                                {tx('Rice done cooking', 'Arroz terminado')} — {tx('batch', 'lote')} #{batchNo ?? '…'}
                            </div>
                            {!todayReady && (
                                <p className="text-[12px] text-sky-900 mb-2">{tx("Loading today's batches…", 'Cargando los lotes de hoy…')}</p>
                            )}
                            {numberUnsure && (
                                <p className="text-[12px] font-bold text-amber-800 mb-2">
                                    {tx("Couldn't load today's batches yet — the batch number may repeat. You can still log the batch.",
                                        'Aún no se cargan los lotes de hoy — el número del lote podría repetirse. Igual puedes registrarlo.')}
                                </p>
                            )}
                            <div className="flex items-center gap-2 mb-2">
                                <label className="text-xs font-bold text-dd-text-2 flex-shrink-0" htmlFor="rice-cooked-time">
                                    {tx('Finished at', 'Terminó a las')}
                                </label>
                                <input
                                    id="rice-cooked-time"
                                    type="time"
                                    value={cookedTime}
                                    onChange={(e) => { setTimeTouched(true); setCookedTime(e.target.value); }}
                                    className="px-2 py-1.5 border border-sky-300 rounded-lg text-sm font-bold bg-white"
                                />
                                {timeTouched && (
                                    <button type="button" onClick={() => setTimeTouched(false)}
                                        className="text-[11px] font-bold text-sky-800 underline">
                                        {tx('Now', 'Ahora')}
                                    </button>
                                )}
                                <div className="ml-auto flex items-center gap-1">
                                    <button type="button" onClick={() => setCopies((c) => Math.max(1, c - 1))}
                                        className="w-7 h-7 rounded-full bg-white border border-sky-300 font-black">−</button>
                                    <span className="text-xs font-bold w-12 text-center">{copies} 🏷</span>
                                    <button type="button" onClick={() => setCopies((c) => Math.min(4, c + 1))}
                                        className="w-7 h-7 rounded-full bg-white border border-sky-300 font-black">+</button>
                                </div>
                            </div>
                            {deadlines && !cookedInFuture && (
                                <div className="text-[12px] text-sky-950 mb-2 leading-snug">
                                    ❄ {tx('Fridge by', 'Refrigerar antes de')} <b>{fmtRiceTime(deadlines.fridgeByAt.toISOString())}</b>
                                    {' · '}🗑 {tx('Toss at', 'Tirar a las')} <b>{fmtRiceTime(deadlines.tossByAt.toISOString())}</b>
                                </div>
                            )}
                            {cookedInFuture && (
                                <p className="text-[12px] font-bold text-red-700 mb-2">{tx('That time is in the future.', 'Esa hora es en el futuro.')}</p>
                            )}
                            {alreadyPastToss && !cookedInFuture && (
                                <p className="text-[12px] font-bold text-red-700 mb-2">
                                    {tx('That batch is already past the 4-hour limit — it must be tossed, not stickered.',
                                        'Ese lote ya pasó el límite de 4 horas — se debe tirar, no etiquetar.')}
                                </p>
                            )}
                            <button
                                type="button"
                                onClick={handleStart}
                                disabled={starting || !todayReady || !cookedAt || cookedInFuture || alreadyPastToss}
                                className="w-full py-3 rounded-xl bg-sky-600 text-white text-sm font-black shadow-sm active:scale-[0.99] disabled:opacity-40">
                                {starting ? tx('Printing…', 'Imprimiendo…') : `🏷 ${tx('Print sticker + log batch', 'Imprimir etiqueta + registrar lote')}`}
                            </button>
                        </div>

                        {/* Day picker + inspector print */}
                        <div className="flex items-center gap-2">
                            <input
                                type="date"
                                value={viewDay}
                                max={todayS}
                                onChange={(e) => e.target.value && setViewDay(e.target.value)}
                                className="px-2 py-1.5 border border-dd-line rounded-lg text-xs font-bold bg-white"
                            />
                            {!viewingToday && (
                                <button type="button" onClick={() => setViewDay(todayS)} className="text-[11px] font-bold text-sky-800 underline">
                                    {tx('Today', 'Hoy')}
                                </button>
                            )}
                            <button type="button" onClick={printLog} disabled={!rows}
                                className="ml-auto inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-white border-2 border-dd-line text-xs font-black text-dd-text active:scale-95 disabled:opacity-40">
                                <Printer size={14} /> {tx('Print log', 'Imprimir registro')}
                            </button>
                        </div>
                        {viewingToday && overdueCount > 0 && (
                            <div className="rounded-lg bg-red-600 text-white text-sm font-black px-3 py-2">
                                🗑 {tx(`${overdueCount} batch${overdueCount === 1 ? ' is' : 'es are'} past 4 hours — toss now`,
                                    `${overdueCount} lote${overdueCount === 1 ? '' : 's'} pasó las 4 horas — tirar ya`)}
                            </div>
                        )}

                        {/* Batches */}
                        {rows === null ? (
                            <p className="text-center text-sm text-dd-text-2 py-6">{tx('Loading…', 'Cargando…')}</p>
                        ) : loadError ? (
                            <p className="text-center text-sm font-bold text-red-700 py-6">
                                {tx('Could not load the rice log — check your connection and reopen.',
                                    'No se pudo cargar el registro — revisa tu conexión y vuelve a abrir.')}
                            </p>
                        ) : rows.length === 0 ? (
                            <p className="text-center text-sm text-dd-text-2 py-6">
                                {viewingToday ? tx('No rice batches yet today.', 'Aún no hay lotes hoy.') : tx('No rice batches logged that day.', 'No hay lotes ese día.')}
                            </p>
                        ) : (
                            <div className="space-y-2">
                                {[...rows].reverse().map((r) => (
                                    <BatchRow
                                        key={r.id}
                                        row={r}
                                        now={now}
                                        tx={tx}
                                        isEs={isEs}
                                        busy={busyIds.has(r.id)}
                                        canAct={viewingToday}
                                        duplicate={dupNumbers.has(r.batchNo) && r.status !== RICE_STATUS.VOID}
                                        fridgeOpen={fridgeFor === r.id}
                                        fridgeTemp={fridgeTemp}
                                        setFridgeTemp={setFridgeTemp}
                                        onOpenFridge={() => { setFridgeFor(r.id); setFridgeTemp(''); }}
                                        onCancelFridge={() => setFridgeFor(null)}
                                        onConfirmFridge={() => confirmFridge(r)}
                                        onUsed={() => run(r, () => markRiceUsed(r, staffName), tx('✅ Logged as used', '✅ Registrado como usado'))}
                                        onTossed={() => run(r, () => markRiceTossed(r, staffName, new Date()), tx('🗑 Logged as tossed', '🗑 Registrado como tirado'))}
                                        onReprint={() => reprint(r)}
                                        onVoid={() => voidBatch(r)}
                                    />
                                ))}
                            </div>
                        )}
                    </div>

                    <div className="border-t border-dd-line px-4 py-2.5 flex-shrink-0 safe-bottom text-[12px] text-dd-text-2">
                        {tx(`Today: ${(todayRows || []).filter((r) => r.status !== RICE_STATUS.VOID).length} batches · ${openCount} still out`,
                            `Hoy: ${(todayRows || []).filter((r) => r.status !== RICE_STATUS.VOID).length} lotes · ${openCount} afuera`)}
                    </div>
                </div>
            </div>
        </ModalPortal>
    );
}

function BatchRow({
    row, now, tx, isEs, busy, canAct, duplicate,
    fridgeOpen, fridgeTemp, setFridgeTemp, onOpenFridge, onCancelFridge, onConfirmFridge,
    onUsed, onTossed, onReprint, onVoid,
}) {
    const state = riceBatchState(row, now);
    const open = row.status === RICE_STATUS.COOLING;
    const printedOk = (row.prints || []).some((p) => p.ok);
    const printTried = (row.prints || []).length > 0;
    const msToFridge = new Date(row.fridgeByAt).getTime() - now.getTime();
    const msToToss = new Date(row.tossByAt).getTime() - now.getTime();

    const tone = !open
        ? 'border-dd-line bg-white'
        : state === 'tossNow' ? 'border-red-400 bg-red-50'
            : state === 'fridgeLate' ? 'border-amber-400 bg-amber-50'
                : 'border-sky-300 bg-white';

    return (
        <div className={`rounded-xl border-2 p-2.5 ${tone} ${row.status === RICE_STATUS.VOID ? 'opacity-50' : ''}`}>
            <div className="flex items-start gap-2">
                <div className="flex-1 min-w-0">
                    <div className={`text-sm font-black text-dd-text ${row.status === RICE_STATUS.VOID ? 'line-through' : ''}`}>
                        #{row.batchNo} · {tx('Cooked', 'Cocido')} {fmtRiceTime(row.cookedAt)}
                        <span className="font-normal text-dd-text-2"> · {row.cookedBy}</span>
                        {duplicate && (
                            <span className="ml-1.5 align-middle inline-block px-1.5 py-0.5 rounded-full bg-amber-100 border border-amber-300 text-amber-900 text-[10px] font-black">
                                {tx('same # as another batch', 'mismo # que otro lote')}
                            </span>
                        )}
                    </div>
                    <div className="text-[11px] text-dd-text-2">
                        ❄ {fmtRiceTime(row.fridgeByAt)} · 🗑 {fmtRiceTime(row.tossByAt)}
                        {printedOk && ` · 🏷 ×${row.stickerCount || 1}`}
                    </div>
                    {open && canAct && (
                        <div className={`text-[12px] font-black mt-0.5 ${state === 'tossNow' ? 'text-red-700' : state === 'fridgeLate' ? 'text-amber-800' : 'text-sky-800'}`}>
                            {state === 'tossNow'
                                ? tx('PAST 4 HOURS — TOSS IT', 'PASÓ 4 HORAS — TÍRALO')
                                : state === 'fridgeLate'
                                    ? tx(`Past fridge-by — use or toss in ${fmtLeft(msToToss)}`, `Pasó la hora de refrigerar — usa o tira en ${fmtLeft(msToToss)}`)
                                    : tx(`Fridge by in ${fmtLeft(msToFridge)} · toss in ${fmtLeft(msToToss)}`, `Refrigerar en ${fmtLeft(msToFridge)} · tirar en ${fmtLeft(msToToss)}`)}
                        </div>
                    )}
                    {!open && (
                        <div className="text-[12px] font-bold text-dd-text mt-0.5">{riceOutcomeText(row, isEs)}</div>
                    )}
                    {open && printTried && !printedOk && (
                        <div className="text-[11px] font-bold text-red-700 mt-0.5">⚠ {tx("Sticker didn't print", 'La etiqueta no se imprimió')}</div>
                    )}
                </div>
                {open && canAct && (
                    <button type="button" onClick={onReprint} disabled={busy}
                        className="flex-shrink-0 px-2 py-1 rounded-lg bg-white border border-dd-line text-[11px] font-bold active:scale-95 disabled:opacity-40">
                        🏷 {tx('Reprint', 'Reimprimir')}
                    </button>
                )}
            </div>

            {open && canAct && !fridgeOpen && (
                <div className="flex gap-1.5 mt-2">
                    {state !== 'tossNow' && (
                        <button type="button" onClick={onUsed} disabled={busy}
                            className="flex-1 inline-flex items-center justify-center gap-1 py-1.5 rounded-lg bg-dd-green-50 border border-dd-green/40 text-dd-green-700 text-xs font-black active:scale-95 disabled:opacity-40">
                            <CheckCircle2 size={13} /> {tx('Used', 'Usado')}
                        </button>
                    )}
                    {state === 'ok' && (
                        <button type="button" onClick={onOpenFridge} disabled={busy}
                            className="flex-1 inline-flex items-center justify-center gap-1 py-1.5 rounded-lg bg-sky-50 border border-sky-300 text-sky-800 text-xs font-black active:scale-95 disabled:opacity-40">
                            <Snowflake size={13} /> {tx('In fridge', 'Al refri')}
                        </button>
                    )}
                    <button type="button" onClick={onTossed} disabled={busy}
                        className={`flex-1 inline-flex items-center justify-center gap-1 py-1.5 rounded-lg text-xs font-black active:scale-95 disabled:opacity-40 ${state === 'tossNow' ? 'bg-red-600 text-white' : 'bg-red-50 border border-red-200 text-red-700'}`}>
                        <Trash2 size={13} /> {tx('Tossed', 'Tirado')}
                    </button>
                </div>
            )}
            {open && !canAct && (
                <div className="mt-2">
                    <p className="text-[11px] font-bold text-amber-800 mb-1.5">
                        {tx('Left open — record what happened to it.', 'Quedó abierto — registra qué pasó.')}
                    </p>
                    <div className="flex gap-1.5">
                        {/* No "printed by mistake" on a past day: a batch left
                            out overnight is a real time-control miss, and the
                            log must show it tossed, not voided. */}
                        <button type="button" onClick={onTossed} disabled={busy}
                            className="flex-1 inline-flex items-center justify-center gap-1 py-1.5 rounded-lg bg-red-600 text-white text-xs font-black active:scale-95 disabled:opacity-40">
                            <Trash2 size={13} /> {tx('Tossed', 'Tirado')}
                        </button>
                    </div>
                </div>
            )}
            {open && canAct && fridgeOpen && (
                <div className="flex items-center gap-1.5 mt-2">
                    <input
                        type="number"
                        inputMode="decimal"
                        value={fridgeTemp}
                        onChange={(e) => setFridgeTemp(e.target.value)}
                        placeholder={tx('Temp °F (optional)', 'Temp °F (opcional)')}
                        className="flex-1 min-w-0 px-2 py-1.5 border border-sky-300 rounded-lg text-sm bg-white"
                        autoFocus
                    />
                    <button type="button" onClick={onConfirmFridge} disabled={busy}
                        className="px-3 py-1.5 rounded-lg bg-sky-600 text-white text-xs font-black active:scale-95 disabled:opacity-40">
                        ❄ {tx('Save', 'Guardar')}
                    </button>
                    <button type="button" onClick={onCancelFridge} className="px-2 py-1.5 text-xs font-bold text-dd-text-2">
                        {tx('Cancel', 'Cancelar')}
                    </button>
                </div>
            )}
            {open && canAct && (
                <button type="button" onClick={onVoid} disabled={busy}
                    className="mt-1.5 text-[10.5px] font-bold text-dd-text-2 underline">
                    {tx('Printed by mistake?', '¿Impreso por error?')}
                </button>
            )}
        </div>
    );
}
