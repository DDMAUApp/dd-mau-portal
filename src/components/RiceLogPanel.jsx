// RiceLogPanel — the rice screen (Andrew 2026-11-02, rebuilt 2026-11-03).
//
// Tapping the Fried Rice Rice sticker opens this: roll the wheel to the probe
// reading, pick the time, tap one of two print buttons. Every sticker logs a
// row first, and the log write never waits on the server, so a kitchen Wi-Fi
// drop can't stop a sticker. A batch can always be started, even if the day's
// rows can't load. If the printer fails, the row is still saved and the screen
// shows the deadlines huge so the cook can write them on tape. If that screen
// has gone by then, a toast carries the same times.
//
// The same modal's Log view is the Rice Log tab (RiceLogTab). Open to all
// staff: the cook who pulls the rice is the one who logs it.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import ModalPortal from './ModalPortal';
import { toast } from '../toast';
import {
    RICE_MAX_LATE_MINUTES, RICE_MAX_COPIES, RICE_MIN_START_F, RICE_ROUTE_FRIDGE, RICE_ROUTE_TODAY,
    RICE_WHEEL_MAX_F, RICE_WHEEL_MIN_F, RICE_WHEEL_START_F,
    duplicateBatchNumbers, isRiceOpen, loadRiceAttempts, logRiceLowReading, logRiceTossedAtStart, nextBatchNo, riceDayStr, riceOlderOpen,
    riceScreenDay, riceStoreLabel, saveRiceAttempts, startRiceBatch, subscribeOpenRice, subscribeRiceLog,
} from '../data/riceLog';
import { riceRouteDeadlines, stickerDay, stickerTime } from '../data/riceSticker';
import { isShiftLeadOrAbove } from '../data/staff';
import RiceBatchRow, { ReprintCount, RiceTossAlerts } from './RiceBatchRow';
import RiceLogTab from './RiceLogTab';
import RiceTempWheel from './RiceTempWheel';
import RiceTimeWheel, { RICE_TOO_LATE } from './RiceTimeWheel';
import { ricePrintMessage, useRiceBatchActions } from './useRiceBatchActions';

const OLDER_LINE_MAX = 3;
const TOO_LATE = RICE_TOO_LATE;    // the wheel's stop for rice unmarked over an hour

export default function RiceLogPanel({
    location = 'webster', staffName, staffList = [], language = 'en', initialView = 'start', onClose,
}) {
    const isEs = language === 'es';
    const tx = useCallback((en, es) => (isEs ? es : en), [isEs]);
    const loc = location === 'both' ? 'webster' : location;
    const [view, setView] = useState(initialView);
    // A print can outlast the screen, or the screen can move to the log view.
    const viewRef = useRef(view);
    viewRef.current = view;
    const mountedRef = useRef(true);
    useEffect(() => {
        mountedRef.current = true;
        return () => { mountedRef.current = false; };
    }, []);

    // Live clock for what's on screen, redrawn when the minute turns so the
    // deadlines on the print buttons stay right. Printing reads the real clock
    // again at the moment of the tap, never this.
    const [now, setNow] = useState(() => new Date());
    useEffect(() => {
        const id = setInterval(() => {
            setNow((prev) => {
                const d = new Date();
                return Math.floor(d.getTime() / 60000) === Math.floor(prev.getTime() / 60000) ? prev : d;
            });
        }, 1000);
        return () => clearInterval(id);
    }, []);
    const todayS = riceDayStr(now);

    // Today's rows, for the next batch number. Starting a batch waits a few
    // seconds for them; after that (slow or wedged connection, first batch of
    // the day) the cook can still log. A missing health-log entry is worse
    // than a repeated number, which is flagged on screen and on the log. An
    // answer from this device's saved copy can be missing another device's
    // batches, so it doesn't count as loaded: the number stays unsure until the
    // server has answered.
    const [todayRows, setTodayRows] = useState(null);
    const [todayFromCache, setTodayFromCache] = useState(false);
    const [todayError, setTodayError] = useState(false);
    const [todayWaitOver, setTodayWaitOver] = useState(false);
    useEffect(() => {
        setTodayRows(null);
        setTodayFromCache(false);
        setTodayError(false);
        return subscribeRiceLog(loc, todayS, (r, m) => {
            setTodayRows(r);
            setTodayFromCache(!!m?.fromCache);
            setTodayError(false);
        }, () => setTodayError(true));
    }, [loc, todayS]);
    useEffect(() => {
        setTodayWaitOver(false);
        const t = setTimeout(() => setTodayWaitOver(true), 5000);
        return () => clearTimeout(t);
    }, [loc, todayS]);
    const todayLoaded = Array.isArray(todayRows) && !todayFromCache && !todayError;
    const todayReady = todayLoaded || todayError || todayWaitOver;
    const numberUnsure = todayReady && !todayLoaded;
    const batchNo = todayReady ? nextBatchNo(todayRows || []) : null;
    const dupNumbers = useMemo(() => duplicateBatchNumbers(todayRows), [todayRows]);

    // Open batches from any day, for the older-batches line.
    const [openRows, setOpenRows] = useState([]);
    useEffect(() => {
        setOpenRows([]);
        return subscribeOpenRice(loc, (r) => setOpenRows(r), () => {});
    }, [loc]);
    const older = useMemo(() => riceOlderOpen(openRows, now), [openRows, now]);

    const staffRecord = useMemo(() => (staffList || []).find((s) => s.name === staffName) || null, [staffList, staffName]);
    const isLead = isShiftLeadOrAbove(staffRecord);
    const actions = useRiceBatchActions({ location: loc, staffName, language });

    // ── The reading ───────────────────────────────────────────────────
    // null until a person touches the wheel. Print stays locked until then, so
    // an untouched wheel can't log a temperature nobody measured.
    const [reading, setReading] = useState(null);       // { value, setBy }
    const [wheelKey, setWheelKey] = useState(0);
    const [needTouch, setNeedTouch] = useState(false);
    // This cook's low readings so far on this batch, and the ids they were
    // logged under. Each one is on the record the moment it's taken.
    const [{ attempts: lowAttempts, ids: lowIds }, setLow] = useState(() => loadRiceAttempts(loc, staffName));
    const stillLow = lowAttempts.length >= 2;
    const onWheel = useCallback((value, setBy) => {
        setReading({ value, setBy });
        setNeedTouch(false);
    }, []);

    const [timeChoice, setTimeChoice] = useState(0);    // minutes ago, or TOO_LATE
    const [copies, setCopies] = useState(1);
    const [starting, setStarting] = useState(false);
    const startingRef = useRef(false);
    const [fridgeMsg, setFridgeMsg] = useState(false);
    const [needWait, setNeedWait] = useState(false);
    const [lastResult, setLastResult] = useState(null); // { row, res, printed }
    const bodyRef = useRef(null);

    const minutesLate = timeChoice === TOO_LATE ? 0 : timeChoice;
    const canFridge = minutesLate === 0;

    const clearStart = () => {
        setReading(null);
        setWheelKey((k) => k + 1);
        setNeedTouch(false);
        setFridgeMsg(false);
        setTimeChoice(0);
        setCopies(1);
        setLow({ attempts: [], ids: [] });
        saveRiceAttempts(loc, staffName, []);
    };

    const handlePrint = async (route) => {
        if (startingRef.current) return;
        if (!todayReady) { setNeedWait(true); return; }
        if (!reading) { setNeedTouch(true); return; }
        if (route === RICE_ROUTE_FRIDGE && !canFridge) { setFridgeMsg(true); return; }
        const attempts = [...lowAttempts, reading.value];

        // Below 135F nothing prints. The attempt is logged now, whatever the
        // cook does next, and the wheel reopens at the start number, not at the
        // last reading. Not awaited: a Wi-Fi drop can't hold up the re-probe.
        if (reading.value < RICE_MIN_START_F) {
            const low = logRiceLowReading({ now: new Date(), tempF: reading.value, setBy: reading.setBy, location: loc, staffName });
            low.write.catch((e) => {
                console.warn('rice_log low reading failed:', e);
                toast(tx(`The ${reading.value}°F reading did not save to the log.`, `La lectura de ${reading.value}°F no se guardó en el registro.`), { kind: 'error', duration: 6000 });
            });
            const ids = [...lowIds, low.id];
            setLow({ attempts, ids });
            saveRiceAttempts(loc, staffName, attempts, ids);
            setReading(null);
            setWheelKey((k) => k + 1);
            setNeedTouch(false);
            return;
        }

        startingRef.current = true;
        setStarting(true);
        setLastResult(null);
        try {
            // The clock at the moment of the tap, not the last render.
            const madeAt = new Date(Date.now() - minutesLate * 60000);
            const number = batchNo;
            const { res, row, logFailed } = await startRiceBatch({
                madeAt,
                route,
                location: loc,
                staffName,
                batchNo: number,
                copies,
                startTempF: reading.value,
                startAttempts: attempts,
                lowReadingIds: lowIds,
                startSetBy: reading.setBy,
                timeSource: minutesLate > 0 ? 'picked' : 'now',
                minutesLate,
            });
            if (res.ok) {
                toast(tx(`Batch #${number} logged and sticker printed`, `Lote #${number} registrado y etiqueta impresa`), { kind: 'success' });
            }
            setLastResult({ row, res, printed: res.copiesPrinted || 0 });
            // The card below is the cook's way to see this. If they closed the
            // screen or moved to the log while the printer was thinking, a toast
            // has to carry the failure and the times for the tape.
            if (!res.ok && res.error !== 'cancelled' && !(mountedRef.current && viewRef.current === 'start')) {
                const times = route === RICE_ROUTE_FRIDGE
                    ? `${tx('70F by', '70F antes de')} ${stickerTime(row.seventyByAt)}, ${tx('41F by', '41F antes de')} ${stickerTime(row.fortyOneByAt)}, ${tx('use by', 'usar antes de')} ${stickerDay(row.useByDay)}.`
                    : `${tx('Toss by', 'Tirar antes de')} ${stickerTime(row.tossByAt)}.`;
                toast(`${tx(`Batch #${number} is saved.`, `El lote #${number} está guardado.`)} ${ricePrintMessage(res, isEs)} ${times}`, { kind: 'error', duration: 12000 });
            }
            if (logFailed) {
                toast(tx('Could not save the batch to the log. Check the Wi-Fi.', 'No se pudo guardar el lote. Revisa el Wi-Fi.'), { kind: 'error', duration: 6000 });
            }
            clearStart();
            // The tape-it-now card is at the top. A clean print stays put.
            if (!res.ok && bodyRef.current) bodyRef.current.scrollTop = 0;
        } finally {
            startingRef.current = false;
            setStarting(false);
        }
    };

    // No sticker on these. One tap logs a tossed row.
    const handleToss = (reason) => {
        if (startingRef.current || !todayReady) return;
        const number = batchNo;
        logRiceTossedAtStart({
            now: new Date(),
            reason,
            location: loc,
            cookedBy: staffName,
            batchNo: number,
            startAttempts: lowAttempts,
            lowReadingIds: lowIds,
            pans: copies,
        }).catch((e) => {
            console.warn('rice_log tossed row failed:', e);
            toast(tx(`Batch #${number} did not save. Try again.`, `El lote #${number} no se guardó. Intenta de nuevo.`), { kind: 'error', duration: 6000 });
        });
        toast(tx(`Batch #${number} logged as tossed. No sticker.`, `Lote #${number} registrado como tirado. Sin etiqueta.`), { kind: 'success' });
        setLastResult(null);
        clearStart();
    };

    // What each button will print, from the same function as the sticker.
    const shownMade = new Date(now.getTime() - minutesLate * 60000);
    const todayD = riceRouteDeadlines(RICE_ROUTE_TODAY, shownMade);
    const fridgeD = riceRouteDeadlines(RICE_ROUTE_FRIDGE, new Date(now.getTime()));

    const wheelBelow = !!reading && reading.value < RICE_MIN_START_F;
    // On a tablet the older batches sit beside the wheel, so the next cook
    // sees both without scrolling.
    const sideBySide = view === 'start' && older.length > 0;
    const firstLowDone = lowAttempts.length === 1;
    // The tape-it-now card goes by the live row: once that ticket is deleted or
    // closed, there's no pan to tape up under it.
    const lastLive = lastResult ? (todayRows || []).find((r) => r.id === lastResult.row.id) || null : null;
    const showFailed = !!lastResult && !lastResult.res.ok && lastResult.res.error !== 'cancelled'
        && (!lastLive || isRiceOpen(lastLive));

    return (
        <ModalPortal onBackPress={onClose}>
            <div className="fixed inset-0 z-[80] bg-black/40 flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={onClose}>
                <div className={`bg-white w-full sm:max-w-lg ${sideBySide ? 'md:max-w-3xl' : ''} sm:rounded-2xl rounded-t-2xl max-h-[94vh] flex flex-col shadow-2xl`} onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center gap-2 p-3 border-t-4 border-sky-500 flex-shrink-0">
                        <span className="text-2xl" aria-hidden="true">🍚</span>
                        <div className="flex-1 min-w-0">
                            <h2 className="text-base font-black text-dd-text leading-tight">{tx('Fried Rice Rice', 'Arroz para freír')}</h2>
                            <p className="text-[12px] font-bold text-dd-text-2 truncate">{riceStoreLabel(loc)} · {staffName}</p>
                        </div>
                        <button type="button" onClick={onClose} aria-label={tx('Close', 'Cerrar')} className="p-2 -m-1 text-dd-text-2 hover:text-dd-text"><X size={20} /></button>
                    </div>
                    <div className="flex gap-1.5 px-3 pb-2 flex-shrink-0">
                        {[['start', tx('Start a batch', 'Empezar lote')], ['log', tx('Rice Log', 'Registro')]].map(([id, label]) => (
                            <button key={id} type="button" onClick={() => setView(id)} aria-pressed={view === id}
                                className={`flex-1 min-h-[44px] rounded-lg text-sm font-black border ${view === id ? 'bg-sky-600 text-white border-sky-600' : 'bg-white text-dd-text border-dd-line'}`}>
                                {label}
                            </button>
                        ))}
                    </div>

                    <div ref={bodyRef} className="flex-1 overflow-y-auto px-3 pb-3 space-y-3">
                        {view === 'log' ? (
                            <RiceLogTab location={loc} staffName={staffName} staffList={staffList} language={language} embedded actions={actions} />
                        ) : (
                            <>
                                <RiceTossAlerts actions={actions} tx={tx} />
                                {showFailed && (
                                    <PrintFailed result={lastResult} tx={tx} isEs={isEs}
                                        busy={actions.busyIds.has(lastResult.row.id) || !!actions.pending[lastResult.row.id]}
                                        onReprint={async (count) => {
                                            const { row, res: failure, printed } = lastResult;
                                            const res = await actions.reprint(lastLive || row, count);
                                            if (!res) return;
                                            const total = printed + (res.ok ? count : (res.copiesPrinted || 0));
                                            // The card stays until every pan is covered.
                                            if (res.ok && total >= row.pans) setLastResult(null);
                                            else setLastResult({ row, res: res.ok ? failure : res, printed: total });
                                        }}
                                        onCameOut={(count) => {
                                            actions.confirmPrinted(lastResult.row, count);
                                            setLastResult(null);
                                        }}
                                        onDismiss={() => setLastResult(null)} />
                                )}

                                <div className={sideBySide ? 'space-y-3 md:space-y-0 md:grid md:grid-cols-2 md:gap-3 md:items-start' : ''}>
                                {older.length > 0 && (
                                    <section className="space-y-2" aria-label={tx('Older batches', 'Lotes anteriores')}>
                                        <h3 className="text-sm font-black text-dd-text">{tx('Older batches: all pans gone?', 'Lotes anteriores: ¿ya no hay bandejas?')}</h3>
                                        {older.slice(0, OLDER_LINE_MAX).map((r) => (
                                            <RiceBatchRow key={r.id} row={r} dayRows={[r]} compact showDay={r.cookDay !== todayS}
                                                now={now} tx={tx} isEs={isEs} isLead={isLead} staffName={staffName} actions={actions} />
                                        ))}
                                        {older.length > OLDER_LINE_MAX && (
                                            <button type="button" onClick={() => setView('log')} className="text-xs font-bold text-sky-800 underline min-h-[36px]">
                                                {tx(`${older.length - OLDER_LINE_MAX} more in the Rice Log`, `${older.length - OLDER_LINE_MAX} más en el registro`)}
                                            </button>
                                        )}
                                    </section>
                                )}

                                <div className="rounded-xl border-2 border-sky-200 bg-sky-50 p-3 space-y-3">
                                    <div className="text-base font-black text-sky-950">
                                        {tx('New batch', 'Lote nuevo')} #{batchNo ?? '…'}
                                        {batchNo != null && dupNumbers.size > 0 && (
                                            <span className="ml-2 align-middle inline-block px-1.5 py-0.5 rounded-full bg-amber-100 border border-amber-300 text-amber-900 text-[10px] font-black">
                                                {tx('a number is used twice today', 'un número se repitió hoy')}
                                            </span>
                                        )}
                                    </div>
                                    {!todayReady && (
                                        <p className="text-[12px] text-sky-900">{tx("Loading today's batches…", 'Cargando los lotes de hoy…')}</p>
                                    )}
                                    {numberUnsure && (
                                        <p className="text-[12px] font-bold text-amber-800">
                                            {tx("Couldn't load today's batches yet, so the batch number may repeat. You can still log the batch.",
                                                'Aún no se cargan los lotes de hoy, así que el número podría repetirse. Igual puedes registrarlo.')}
                                        </p>
                                    )}

                                    {stillLow ? (
                                        <div className="rounded-lg bg-red-600 text-white p-3 space-y-2">
                                            <div className="text-2xl font-black">{tx('Still low. Toss it.', 'Sigue bajo. Tíralo.')}</div>
                                            <div className="text-sm font-bold">{lowAttempts.map((t) => `${t}°F`).join(', ')}. {tx('No sticker.', 'Sin etiqueta.')}</div>
                                            <button type="button" onClick={() => handleToss('below_135')} disabled={!todayReady}
                                                className="w-full min-h-[52px] rounded-lg bg-white text-red-700 text-lg font-black active:scale-[0.99] disabled:opacity-40">
                                                {tx('Toss', 'Tirar')}
                                            </button>
                                        </div>
                                    ) : timeChoice === TOO_LATE ? (
                                        <>
                                            <div className="rounded-lg bg-red-600 text-white p-3 space-y-2">
                                                <div className="text-2xl font-black">{tx('Unmarked too long. Toss it.', 'Sin marcar mucho tiempo. Tíralo.')}</div>
                                                <div className="text-sm font-bold">{tx('More than an hour with no mark gets no sticker.', 'Más de una hora sin marcar no lleva etiqueta.')}</div>
                                                <button type="button" onClick={() => handleToss('no_sticker')} disabled={!todayReady}
                                                    className="w-full min-h-[52px] rounded-lg bg-white text-red-700 text-lg font-black active:scale-[0.99] disabled:opacity-40">
                                                    {tx('Toss it', 'Tíralo')}
                                                </button>
                                            </div>
                                            <RiceTimeWheel value={timeChoice} now={now} maxMinutes={RICE_MAX_LATE_MINUTES} resetKey={wheelKey} onChange={(v) => { setTimeChoice(v); setFridgeMsg(false); }} tx={tx} />
                                        </>
                                    ) : (
                                        <>
                                            {firstLowDone && (
                                                <div className="rounded-lg bg-red-600 text-white p-3">
                                                    <div className="text-xl font-black">{tx('Probe again in the center.', 'Mide otra vez en el centro.')}</div>
                                                    <div className="text-sm font-bold">{tx(`${lowAttempts[0]}°F is below ${RICE_MIN_START_F}°F. Nothing printed.`, `${lowAttempts[0]}°F es menos de ${RICE_MIN_START_F}°F. No se imprimió.`)}</div>
                                                </div>
                                            )}
                                            <div>
                                                <p className="text-[13px] font-bold text-sky-950 mb-1">
                                                    {tx('Probe in the cooker. Roll to the reading, or tap the number if it matches.', 'Mide en la olla. Gira hasta la lectura, o toca el número si coincide.')}
                                                </p>
                                                {/* Narrower than the card: the gutters are where a thumb
                                                    scrolls the screen without rolling the wheel. */}
                                                <div className="w-3/4 mx-auto">
                                                <RiceTempWheel
                                                    start={RICE_WHEEL_START_F}
                                                    min={RICE_WHEEL_MIN_F}
                                                    max={RICE_WHEEL_MAX_F}
                                                    dangerBelow={RICE_MIN_START_F}
                                                    initial={reading?.value ?? null}
                                                    resetKey={wheelKey}
                                                    onChange={onWheel}
                                                    label={tx('Rice temperature, degrees F', 'Temperatura del arroz, grados F')}
                                                />
                                                </div>
                                                {wheelBelow && (
                                                    <p className="mt-1 text-sm font-black text-red-700">{tx(`Below ${RICE_MIN_START_F}°F won't print.`, `Bajo ${RICE_MIN_START_F}°F no se imprime.`)}</p>
                                                )}
                                            </div>

                                            <RiceTimeWheel value={timeChoice} now={now} maxMinutes={RICE_MAX_LATE_MINUTES} resetKey={wheelKey} onChange={(v) => { setTimeChoice(v); setFridgeMsg(false); }} tx={tx} />

                                            <div className="flex items-center justify-between gap-2">
                                                <span className="text-sm font-bold text-sky-950">{tx('Pans (one sticker each)', 'Bandejas (una etiqueta cada una)')}</span>
                                                <div className="flex items-center gap-1">
                                                    <button type="button" aria-label={tx('Fewer pans', 'Menos bandejas')} onClick={() => setCopies((c) => Math.max(1, c - 1))}
                                                        className="w-11 h-11 rounded-full bg-white border border-sky-300 text-lg font-black">−</button>
                                                    <span className="w-8 text-center text-lg font-black tabular-nums" data-testid="rice-pans">{copies}</span>
                                                    <button type="button" aria-label={tx('More pans', 'Más bandejas')} onClick={() => setCopies((c) => Math.min(RICE_MAX_COPIES, c + 1))}
                                                        className="w-11 h-11 rounded-full bg-white border border-sky-300 text-lg font-black">+</button>
                                                </div>
                                            </div>

                                            {needWait && !todayReady && (
                                                <p role="alert" className="rounded-lg bg-amber-100 border border-amber-300 p-2 text-sm font-black text-amber-900">
                                                    {tx("One moment: getting today's batch number. It won't take more than a few seconds.", 'Un momento: buscando el número de lote de hoy. Solo tarda unos segundos.')}
                                                </p>
                                            )}
                                            {needTouch && (
                                                <p role="alert" className="rounded-lg bg-amber-100 border border-amber-300 p-2 text-sm font-black text-amber-900">
                                                    {tx('Touch the wheel first: roll to the reading, or tap the number if the probe matches it.',
                                                        'Toca la rueda primero: gira hasta la lectura, o toca el número si coincide con el termómetro.')}
                                                </p>
                                            )}
                                            {fridgeMsg && (
                                                <p role="alert" className="rounded-lg bg-amber-100 border border-amber-300 p-2 text-sm font-black text-amber-900">
                                                    {tx('For the Fridge prints with Now only. Roll the time back to Now, or use For Today.', 'Para el refri solo imprime con Ahora. Regresa la hora a Ahora, o usa Para hoy.')}
                                                </p>
                                            )}

                                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                                <button type="button" onClick={() => handlePrint(RICE_ROUTE_TODAY)} disabled={starting}
                                                    className="min-h-[92px] p-3 rounded-xl bg-amber-500 text-white text-left shadow-sm active:scale-[0.99] disabled:opacity-60">
                                                    <div className="text-lg font-black leading-tight">{starting ? tx('Printing…', 'Imprimiendo…') : tx('For Today', 'Para hoy')}</div>
                                                    <div className="text-[13px] font-bold">{tx('Wok by', 'Wok antes de')} {stickerTime(todayD.wokByAt)}</div>
                                                    <div className="text-[13px] font-bold">{tx('Toss by', 'Tirar antes de')} {stickerTime(todayD.tossByAt)}</div>
                                                </button>
                                                <button type="button" onClick={() => handlePrint(RICE_ROUTE_FRIDGE)} disabled={starting} aria-disabled={!canFridge}
                                                    className={`min-h-[92px] p-3 rounded-xl text-white text-left shadow-sm active:scale-[0.99] disabled:opacity-60 ${canFridge ? 'bg-sky-600' : 'bg-gray-400'}`}>
                                                    <div className="text-lg font-black leading-tight">{starting ? tx('Printing…', 'Imprimiendo…') : tx('For the Fridge', 'Para el refri')}</div>
                                                    {canFridge ? (
                                                        <>
                                                            <div className="text-[13px] font-bold">{tx('70F by', '70F antes de')} {stickerTime(fridgeD.seventyByAt)} · {tx('41F by', '41F antes de')} {stickerTime(fridgeD.fortyOneByAt)}</div>
                                                            <div className="text-[13px] font-bold">{tx('Use by', 'Usar antes de')} {riceScreenDay(fridgeD.useByDay, isEs)}</div>
                                                        </>
                                                    ) : (
                                                        <div className="text-[13px] font-bold">{tx('Now only', 'Solo Ahora')}</div>
                                                    )}
                                                </button>
                                            </div>
                                        </>
                                    )}
                                </div>
                                </div>
                            </>
                        )}
                    </div>
                </div>
            </div>
        </ModalPortal>
    );
}

// The sticker didn't come out. The row is saved and the failure is on it; the
// cook needs the deadlines big enough to copy onto tape. Every pan needs a
// sticker, so Reprint offers what's still missing. A timed-out job may have
// printed, so that case can say so instead of printing a duplicate.
function PrintFailed({ result, tx, isEs, busy, onReprint, onCameOut, onDismiss }) {
    const { row, res, printed = 0 } = result;
    const fridge = row.route === RICE_ROUTE_FRIDGE;
    const pans = row.pans || 1;
    const missing = Math.max(1, Math.min(RICE_MAX_COPIES, pans - printed));
    const [count, setCount] = useState(missing);
    useEffect(() => { setCount(missing); }, [missing]);
    const timedOut = res.error === 'printer timeout';
    return (
        <div role="alert" className="rounded-xl border-2 border-red-400 bg-red-50 p-3 space-y-1.5">
            <div className="text-sm font-black text-red-800">
                {tx(`Batch #${row.batchNo} is saved.`, `El lote #${row.batchNo} está guardado.`)} {ricePrintMessage(res, isEs)}
            </div>
            <div className="text-[13px] font-bold text-red-900">{tx('Write this on tape:', 'Escribe esto en cinta:')}</div>
            {fridge ? (
                <>
                    <div className="text-3xl font-black text-red-800 tabular-nums">70F {stickerTime(row.seventyByAt)}</div>
                    <div className="text-3xl font-black text-red-800 tabular-nums">41F {stickerTime(row.fortyOneByAt)}</div>
                    <div className="text-3xl font-black text-red-800 tabular-nums">{tx('USE BY', 'USAR')} {stickerDay(row.useByDay)}</div>
                </>
            ) : (
                <>
                    <div className="text-[13px] font-bold text-red-900">{tx('Toss by', 'Tirar antes de')}</div>
                    <div className="text-5xl font-black text-red-800 tabular-nums">{stickerTime(row.tossByAt)}</div>
                </>
            )}
            {printed > 0 && (
                <div className="text-[13px] font-bold text-red-900" data-testid="rice-printed-so-far">
                    {tx(`${printed} of ${pans} stickers are done.`, `${printed} de ${pans} etiquetas listas.`)}
                </div>
            )}
            {missing > 1 && <ReprintCount value={count} onChange={setCount} tx={tx} />}
            <div className="flex flex-wrap gap-1.5">
                <button type="button" onClick={() => onReprint(count)} disabled={busy}
                    className="flex-1 min-h-[44px] rounded-lg bg-white border-2 border-red-300 text-red-800 text-sm font-black active:scale-95 disabled:opacity-40">
                    {count > 1 ? tx(`Reprint ${count}`, `Reimprimir ${count}`) : tx('Reprint', 'Reimprimir')}
                </button>
                {timedOut && (
                    <button type="button" onClick={() => onCameOut(missing)} disabled={busy}
                        className="flex-1 min-h-[44px] rounded-lg bg-white border-2 border-red-300 text-red-800 text-sm font-black active:scale-95 disabled:opacity-40">
                        {tx('It came out', 'Sí salió')}
                    </button>
                )}
                <button type="button" onClick={onDismiss}
                    className="min-h-[44px] px-3 rounded-lg text-sm font-bold text-dd-text-2 underline">
                    {tx('Done', 'Listo')}
                </button>
            </div>
        </div>
    );
}
