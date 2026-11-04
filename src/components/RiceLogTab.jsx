// RiceLogTab — the Rice Log: every batch at one store on one day (2026-11-03).
//
// All-staff tab, and the same screen from the sticker page's Rice log button.
// It opens on today at the store being viewed, and any past day is one tap
// away. When a ticket prints, its row lands here. Open batches from earlier
// days sit at the top so nothing stays invisible. The connection line never
// says "no batches" when it just couldn't load.
import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Printer } from 'lucide-react';
import { toast } from '../toast';
import { printViaNative } from '../capacitor-bridge';
import { isManagerOrAbove, isShiftLeadOrAbove } from '../data/staff';
import { TEST_MODE, testModePrintSkipped } from '../data/testMode';
import {
    buildRiceLogHtml, fmtRiceDay, fmtRiceTime, isRiceDeleted, riceConnectionState, riceDayStr, riceDaySummary,
    riceLowReadingBatch, riceLowReadingText, riceStoreLabel, riceSummaryLine, subscribeOpenRice,
    subscribeRiceLog, subscribeRiceLowReadings,
} from '../data/riceLog';
import RiceBatchRow, { RiceTossAlerts } from './RiceBatchRow';
import { useRiceBatchActions } from './useRiceBatchActions';

const CONNECT_GRACE_MS = 6000;

const shiftDay = (day, delta) => {
    const [y, m, d] = day.split('-').map(Number);
    return riceDayStr(new Date(y, m - 1, d + delta));
};

const CONN_TONE = {
    good: 'text-dd-green-700',
    quiet: 'text-dd-text-2',
    warn: 'text-amber-800',
    bad: 'text-red-700',
};

export default function RiceLogTab({ location = 'webster', staffName, staffList = [], language = 'en', embedded = false, actions: sharedActions = null }) {
    const isEs = language === 'es';
    const tx = (en, es) => (isEs ? es : en);

    // An owner viewing both stores picks one here: rows belong to one store.
    const fixedStore = location === 'webster' || location === 'maryland' ? location : null;
    const [pickedStore, setPickedStore] = useState('webster');
    const loc = fixedStore || pickedStore;

    const staffRecord = useMemo(() => (staffList || []).find((s) => s.name === staffName) || null, [staffList, staffName]);
    const isLead = isShiftLeadOrAbove(staffRecord);
    const canSeeDeleted = isManagerOrAbove(staffRecord);

    // Live clock: countdowns and overdue states. Long-open iPads roll to the
    // new day by themselves unless someone picked a day.
    const [now, setNow] = useState(() => new Date());
    useEffect(() => {
        const id = setInterval(() => setNow(new Date()), 30000);
        return () => clearInterval(id);
    }, []);
    const todayS = riceDayStr(now);
    const [pickedDay, setPickedDay] = useState(null);
    const viewDay = pickedDay || todayS;
    const viewingToday = viewDay === todayS;

    const [rows, setRows] = useState(null);
    const [meta, setMeta] = useState(null);
    const [loadError, setLoadError] = useState(false);
    const [waitedLong, setWaitedLong] = useState(false);
    const [lastServerAt, setLastServerAt] = useState(null);
    useEffect(() => {
        setRows(null);
        setMeta(null);
        setLoadError(false);
        setWaitedLong(false);
        setLastServerAt(null);
        const t = setTimeout(() => setWaitedLong(true), CONNECT_GRACE_MS);
        const stop = subscribeRiceLog(loc, viewDay, (r, m) => {
            setRows(r);
            setMeta(m || null);
            setLoadError(false);
            if (m && !m.fromCache) setLastServerAt(Date.now());
        }, () => setLoadError(true));
        return () => { clearTimeout(t); stop?.(); };
    }, [loc, viewDay]);

    const [openRows, setOpenRows] = useState([]);
    useEffect(() => {
        setOpenRows([]);
        return subscribeOpenRice(loc, (r) => setOpenRows(r), () => {});
    }, [loc]);
    // Readings below 135F are logged on their own, as they're taken.
    const [lowReadings, setLowReadings] = useState([]);
    useEffect(() => {
        setLowReadings([]);
        return subscribeRiceLowReadings(loc, viewDay, (r) => setLowReadings(r), () => {});
    }, [loc, viewDay]);

    const earlierOpen = useMemo(
        () => openRows.filter((r) => r.cookDay && r.cookDay < todayS && r.cookDay !== viewDay),
        [openRows, todayS, viewDay],
    );

    // Inside the rice screen's modal, both views share one set of held closes.
    const ownActions = useRiceBatchActions({ location: loc, staffName, language });
    const actions = sharedActions || ownActions;
    const [showDeleted, setShowDeleted] = useState(false);

    const allRows = rows || [];
    const deletedRows = allRows.filter(isRiceDeleted);
    const visibleRows = allRows.filter((r) => !isRiceDeleted(r) || (showDeleted && canSeeDeleted));
    const summary = useMemo(() => riceDaySummary(allRows, now, lowReadings), [allRows, now, lowReadings]);
    const conn = riceConnectionState({ rows, meta, error: loadError, waitedLong, lastServerAt });
    const canPrint = rows != null && !loadError;

    const printLog = () => {
        if (TEST_MODE) { testModePrintSkipped(); return; }
        if (!canPrint) {
            toast(tx("This day hasn't loaded, so there's nothing to print yet.", 'Este día no ha cargado, aún no hay nada que imprimir.'), { kind: 'error' });
            return;
        }
        const html = buildRiceLogHtml({
            rows: allRows,
            cookDay: viewDay,
            locationLabel: riceStoreLabel(loc),
            printedBy: staffName,
            now: new Date(),
            lowReadings,
            // Saved data prints with a warning on it. It's never a complete day.
            notConfirmed: !conn.canSayEmpty,
            lastServerAt,
        });
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

    const rowProps = { now, tx, isEs, isLead, staffName, actions };

    return (
        <div className={embedded ? 'space-y-3' : 'space-y-3 max-w-2xl mx-auto'}>
            <div className="rounded-2xl border border-dd-line bg-white p-3 space-y-2">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <h1 className="text-xl font-black text-dd-text leading-tight">{riceStoreLabel(loc)}</h1>
                    <div className="text-lg font-black text-dd-text tabular-nums">{fmtRiceDay(viewDay, isEs)}</div>
                </div>
                <div className="text-[12px] font-bold text-dd-text-2">{tx('Rice Log', 'Registro de arroz')}</div>
                {!fixedStore && (
                    <div className="flex gap-1.5">
                        {['webster', 'maryland'].map((s) => (
                            <button key={s} type="button" onClick={() => setPickedStore(s)}
                                className={`flex-1 min-h-[44px] rounded-lg text-sm font-black border ${loc === s ? 'bg-sky-600 text-white border-sky-600' : 'bg-white text-dd-text border-dd-line'}`}>
                                {riceStoreLabel(s)}
                            </button>
                        ))}
                    </div>
                )}
                <div className="flex flex-wrap items-center gap-1.5">
                    <button type="button" aria-label={tx('Previous day', 'Día anterior')} onClick={() => setPickedDay(shiftDay(viewDay, -1))}
                        className="w-11 h-11 rounded-lg border border-dd-line bg-white inline-flex items-center justify-center active:scale-95">
                        <ChevronLeft size={20} />
                    </button>
                    {/* No lower limit: any day ever logged. */}
                    <input type="date" aria-label={tx('Pick a day', 'Elegir un día')} value={viewDay} max={todayS}
                        onChange={(e) => { if (e.target.value) setPickedDay(e.target.value > todayS ? todayS : e.target.value); }}
                        className="min-h-[44px] px-2 border border-dd-line rounded-lg text-sm font-bold bg-white" />
                    <button type="button" aria-label={tx('Next day', 'Día siguiente')} disabled={viewingToday} onClick={() => setPickedDay(shiftDay(viewDay, 1))}
                        className="w-11 h-11 rounded-lg border border-dd-line bg-white inline-flex items-center justify-center active:scale-95 disabled:opacity-30">
                        <ChevronRight size={20} />
                    </button>
                    {!viewingToday && (
                        <button type="button" onClick={() => setPickedDay(null)} className="min-h-[44px] px-2 text-xs font-bold text-sky-800 underline">
                            {tx('Today', 'Hoy')}
                        </button>
                    )}
                    <button type="button" onClick={printLog}
                        className="ml-auto inline-flex items-center gap-1.5 min-h-[44px] px-3 rounded-lg bg-white border-2 border-dd-line text-sm font-black text-dd-text active:scale-95">
                        <Printer size={15} /> {tx('Print / PDF', 'Imprimir / PDF')}
                    </button>
                </div>
                <div className={`text-[13px] font-bold ${CONN_TONE[conn.tone]}`} data-testid="rice-connection">{isEs ? conn.es : conn.en}</div>
                {/* A count from saved data would read as the whole day. */}
                {rows != null && !loadError && conn.canSayEmpty && (
                    <div className="text-sm font-black text-dd-text" data-testid="rice-summary">{riceSummaryLine(summary, isEs)}</div>
                )}
            </div>

            <RiceTossAlerts actions={actions} tx={tx} />

            {earlierOpen.length > 0 && (
                <section className="space-y-2" aria-label={tx('Still open from earlier days', 'Siguen abiertos de días anteriores')}>
                    <h2 className="text-sm font-black text-amber-900">{tx('Still open from earlier days', 'Siguen abiertos de días anteriores')}</h2>
                    {earlierOpen.map((r) => (
                        <RiceBatchRow key={r.id} row={r} dayRows={[r]} showDay {...rowProps} />
                    ))}
                </section>
            )}

            {rows == null ? null : visibleRows.length === 0 ? (
                <p className="text-center text-sm font-bold text-dd-text-2 py-6">
                    {conn.canSayEmpty
                        ? (viewingToday ? tx('No batches logged yet today.', 'Aún no hay lotes hoy.') : tx('No batches logged this day.', 'No hay lotes este día.'))
                        : tx("Can't confirm this day until the log connects.", 'No se puede confirmar este día hasta que el registro conecte.')}
                </p>
            ) : (
                <div className="space-y-2">
                    {visibleRows.map((r) => (
                        <RiceBatchRow key={r.id} row={r} dayRows={allRows} {...rowProps} />
                    ))}
                </div>
            )}

            {lowReadings.length > 0 && (
                <section className="rounded-xl border border-amber-300 bg-amber-50 p-3 space-y-1" aria-label={tx('Readings below 135F', 'Lecturas bajo 135F')}>
                    <h2 className="text-sm font-black text-amber-900">{tx('Readings below 135F (no sticker)', 'Lecturas bajo 135F (sin etiqueta)')}</h2>
                    {lowReadings.map((l) => (
                        <div key={l.id} data-testid="rice-low-reading" className={`text-[13px] text-amber-950 ${riceLowReadingBatch(l, allRows) ? 'font-medium' : 'font-black'}`}>
                            {fmtRiceTime(l.at)} · {l.tempF}°F · {l.by}: {riceLowReadingText(l, allRows, isEs)}
                        </div>
                    ))}
                </section>
            )}

            {canSeeDeleted && deletedRows.length > 0 && (
                <label className="flex items-center gap-2 text-[12px] font-bold text-dd-text-2">
                    <input type="checkbox" checked={showDeleted} onChange={(e) => setShowDeleted(e.target.checked)} />
                    {tx(`Show deleted tickets (${deletedRows.length})`, `Mostrar tickets borrados (${deletedRows.length})`)}
                </label>
            )}
        </div>
    );
}
