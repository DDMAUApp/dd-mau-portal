// RiceBatchRow — one rice batch on the rice screen or the Rice Log
// (2026-11-03): what it is, how it ended, and the buttons it needs right now.
// See src/data/riceLog.js for the rules behind them.
import { useState } from 'react';
import { CheckCircle2, Printer, Snowflake, Thermometer, Trash2 } from 'lucide-react';
import {
    RICE_MAX_41F, RICE_MAX_70F, RICE_MAX_COPIES, RICE_STATUS,
    addRiceReading, buildRiceEdit, editRiceBatch, fmtRiceTime, isRiceDeleted, isRiceFridgeRoute, isRiceOpen,
    logRiceMorningReading, markRiceIntoFridge, parseRiceTemp, riceBatchState, riceDeletePolicy,
    riceEditPolicy, riceEditText, riceGoodMorningReading, riceMadeAt, riceOutcomeText, ricePans, riceReadingTime,
    riceReprintCopies, riceRowFlags,
    riceSawGone, riceScreenDay, softDeleteRiceBatch,
} from '../data/riceLog';
import { RICE_ROUTE_TODAY, stickerDay, stickerTime } from '../data/riceSticker';

const BTN = 'flex-1 min-w-[6.5rem] inline-flex items-center justify-center gap-1.5 min-h-[44px] px-3 py-2 rounded-lg text-sm font-black active:scale-95 disabled:opacity-40';
const INPUT = 'min-h-[44px] px-3 py-2 border border-dd-line rounded-lg text-base bg-white';
const LINK = 'min-h-[36px] px-1 text-xs font-bold text-dd-text-2 underline disabled:opacity-40';

const toInputTime = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

// "1h 05m" / "12m" until a deadline.
function fmtLeft(ms) {
    const m = Math.max(0, Math.round(ms / 60000));
    const h = Math.floor(m / 60);
    return h > 0 ? `${h}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`;
}

function routeChip(row, tx) {
    if (row.route === RICE_ROUTE_TODAY) return { label: tx('For Today', 'Para hoy'), cls: 'bg-amber-100 text-amber-900 border-amber-300' };
    if (isRiceFridgeRoute(row)) return { label: tx('For the Fridge', 'Para el refri'), cls: 'bg-sky-100 text-sky-900 border-sky-300' };
    return { label: tx('Old format', 'Formato anterior'), cls: 'bg-gray-100 text-gray-700 border-gray-300' };
}

function lastPrintFailure(row) {
    const prints = Array.isArray(row.prints) ? row.prints : [];
    if (prints.length === 0 || prints.some((p) => p.ok)) return null;
    return prints[prints.length - 1];
}

// The card a high morning reading leaves, because that batch's row just left
// the list. Stays until someone dismisses it.
export function RiceTossAlerts({ actions, tx }) {
    const alerts = actions.tossAlerts || [];
    if (alerts.length === 0) return null;
    return (
        <div className="space-y-2">
            {alerts.map((a) => (
                <div key={a.id} role="alert" className="rounded-xl bg-red-600 text-white p-3 space-y-2">
                    <div className="text-2xl font-black">{tx(`${a.tempF}F: TOSS IT`, `${a.tempF}F: TÍRALO`)}</div>
                    <div className="text-sm font-bold">{tx(`Batch #${a.batchNo} is above 41F. It's logged as tossed.`, `El lote #${a.batchNo} está sobre 41F. Quedó registrado como tirado.`)}</div>
                    <button type="button" onClick={() => actions.dismissTossAlert(a.id)}
                        className="w-full min-h-[44px] rounded-lg bg-white text-red-700 text-sm font-black active:scale-[0.99]">
                        {tx('Done', 'Listo')}
                    </button>
                </div>
            ))}
        </div>
    );
}

// How many stickers to send. Only asked when more than one pan needs one.
export function ReprintCount({ value, max = RICE_MAX_COPIES, onChange, tx }) {
    return (
        <div className="flex items-center justify-between gap-2">
            <span className="text-[13px] font-bold">{tx('Stickers to print', 'Etiquetas a imprimir')}</span>
            <div className="flex items-center gap-1">
                <button type="button" aria-label={tx('Fewer stickers', 'Menos etiquetas')} onClick={() => onChange(Math.max(1, value - 1))}
                    className="w-11 h-11 rounded-full bg-white border border-dd-line text-lg font-black">−</button>
                <span className="w-8 text-center text-lg font-black tabular-nums" data-testid="rice-reprint-count">{value}</span>
                <button type="button" aria-label={tx('More stickers', 'Más etiquetas')} onClick={() => onChange(Math.min(max, value + 1))}
                    className="w-11 h-11 rounded-full bg-white border border-dd-line text-lg font-black">+</button>
            </div>
        </div>
    );
}

const CLOSE_LABELS = {
    used: ['All Gone', 'Se acabó'],
    saw_gone: ['Saw it gone in time', 'Lo vi acabarse a tiempo'],
    tossed: ['Tossed', 'Tirado'],
    unknown: ["Don't know", 'No se sabe'],
};

export default function RiceBatchRow({
    row, now, tx, isEs, isLead = false, staffName, dayRows = [], actions, compact = false, showDay = false,
}) {
    const [panel, setPanel] = useState(null);     // fridge | reading | morning | edit | history | delete | reprint
    const [denied, setDenied] = useState(null);
    // The screen only redraws every so often. A tap that finds a deadline has
    // passed moves this row's clock up, so it shows the buttons that now apply.
    const [tappedAt, setTappedAt] = useState(null);
    const shownNow = tappedAt && tappedAt > now ? tappedAt : now;
    const state = riceBatchState(row, shownNow);
    const open = isRiceOpen(row);
    const deleted = isRiceDeleted(row);
    const voided = row.status === RICE_STATUS.VOID;
    const busy = actions.busyIds.has(row.id);
    const hold = actions.pending[row.id];
    const flags = riceRowFlags(row, dayRows, shownNow);
    const chip = routeChip(row, tx);
    const fridgeRoute = isRiceFridgeRoute(row);
    const tossedAtStart = row.status === RICE_STATUS.TOSSED && ['below_135', 'no_sticker'].includes(row.tossReason);
    const failed = open ? lastPrintFailure(row) : null;
    const edits = Array.isArray(row.edits) ? row.edits : [];
    const readings = Array.isArray(row.readings) ? row.readings : [];
    const pans = ricePans(row) || null;
    const morningOk = state === 'morning' ? riceGoodMorningReading(row, shownNow) : null;
    const timedOut = failed?.error === 'printer timeout';

    const closePanel = () => { setPanel(null); setDenied(null); };

    const tone = deleted || voided ? 'border-dd-line bg-gray-50 opacity-60'
        : !open ? 'border-dd-line bg-white'
            : state === 'tossNow' || state === 'pastUseBy' ? 'border-red-400 bg-red-50'
                : state === 'past70' ? 'border-amber-400 bg-amber-50'
                    : 'border-sky-300 bg-white';

    const denyEdit = (p) => {
        setPanel(null);
        setDenied(p.why === 'closed'
            ? tx('This batch is closed. Only a shift lead or manager can correct it.', 'Este lote está cerrado. Solo un líder de turno o gerente puede corregirlo.')
            : tx('After 10 minutes, only a shift lead or manager can edit.', 'Después de 10 minutos, solo un líder de turno o gerente puede editar.'));
    };
    const denyDelete = (p) => {
        setPanel(null);
        setDenied(p.why === 'miss'
            ? tx('A batch tossed or past its limit can only be deleted by a shift lead or manager, with a reason.', 'Un lote tirado o pasado del límite solo lo puede borrar un líder de turno o gerente, con una razón.')
            : tx('After 10 minutes, only a shift lead or manager can delete, with a reason.', 'Después de 10 minutos, solo un líder de turno o gerente puede borrar, con una razón.'));
    };
    const tapEdit = () => {
        const p = riceEditPolicy(row, { now: new Date(), isLead });
        if (p.canEdit) { setDenied(null); setPanel(panel === 'edit' ? null : 'edit'); return; }
        denyEdit(p);
    };
    const tapDelete = () => {
        const p = riceDeletePolicy(row, { now: new Date(), isLead });
        if (p.canDelete) { setDenied(null); setPanel(panel === 'delete' ? null : 'delete'); return; }
        denyDelete(p);
    };
    // A reprint only asks how many when more than one pan still needs a sticker.
    const tapReprint = () => {
        setDenied(null);
        if (riceReprintCopies(row) > 1) { setPanel(panel === 'reprint' ? null : 'reprint'); return; }
        setPanel(null);
        actions.reprint(row, 1);
    };
    // A stale screen can still show All Gone just past the deadline. Show the
    // buttons that now apply and let the cook answer them.
    const requestClose = (kind) => {
        const tapped = new Date();
        const fresh = riceBatchState(row, tapped);
        if (kind === 'used' && fresh !== state && (fresh === 'tossNow' || fresh === 'pastUseBy')) {
            setTappedAt(tapped);
            closePanel();
            return;
        }
        closePanel();
        actions.requestClose(row, kind);
    };

    return (
        <div className={`rounded-xl border-2 ${compact ? 'p-2' : 'p-3'} ${tone}`} data-testid={`rice-row-${row.batchNo}`}>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className={`text-lg font-black text-dd-text ${deleted || voided ? 'line-through' : ''}`}>#{row.batchNo}</span>
                <span className={`px-2 py-0.5 rounded-full border text-[11px] font-black ${chip.cls}`}>{chip.label}</span>
                {showDay && (
                    <span className="px-2 py-0.5 rounded-full border border-amber-300 bg-amber-50 text-amber-900 text-[11px] font-black">
                        {tx(`Still open from ${riceScreenDay(row.cookDay)}`, `Sigue abierto desde ${riceScreenDay(row.cookDay, true)}`)}
                    </span>
                )}
                {compact && (
                    <span className="text-[13px] font-bold text-dd-text">
                        {fmtRiceTime(riceMadeAt(row))}
                        {pans != null && ` · ${pans} ${isEs ? (pans === 1 ? 'bandeja' : 'bandejas') : (pans === 1 ? 'pan' : 'pans')}`}
                    </span>
                )}
                {!compact && edits.length > 0 && (
                    <button type="button" onClick={() => setPanel(panel === 'history' ? null : 'history')}
                        className="px-2 py-0.5 rounded-full border border-violet-300 bg-violet-50 text-violet-900 text-[11px] font-black underline">
                        {tx('edited', 'editado')}
                    </button>
                )}
                {!compact && flags.length > 0 && (
                    <span className="px-2 py-0.5 rounded-full border border-orange-300 bg-orange-50 text-orange-900 text-[11px] font-black">
                        ⚑ {tx(`${flags.length} flag${flags.length === 1 ? '' : 's'}`, `${flags.length} alerta${flags.length === 1 ? '' : 's'}`)}
                    </span>
                )}
            </div>

            {!compact && <div className="mt-1 text-sm text-dd-text">
                <b>{row.timeUnknown ? tx('Found', 'Encontrado') : tx('Made', 'Hecho')} {fmtRiceTime(riceMadeAt(row))}</b>
                {' · '}{Number.isFinite(row.startTempF) ? <b>{row.startTempF}°F</b> : <span className="text-dd-text-2">{tx('no reading', 'sin lectura')}</span>}
                {' · '}{row.cookedBy}
                {pans != null && ` · ${pans} ${isEs ? (pans === 1 ? 'bandeja' : 'bandejas') : (pans === 1 ? 'pan' : 'pans')}`}
            </div>}

            {!compact && !tossedAtStart && (
                <div className="text-[13px] text-dd-text-2">
                    {fridgeRoute
                        ? `${tx('70F by', '70F antes de')} ${fmtRiceTime(row.seventyByAt)} · ${tx('41F by', '41F antes de')} ${fmtRiceTime(row.fortyOneByAt)} · ${tx('Use by', 'Usar antes de')} ${riceScreenDay(row.useByDay, isEs)}`
                        : `${row.wokByAt ? `${tx('Wok by', 'Wok antes de')} ${fmtRiceTime(row.wokByAt)} · ` : ''}${tx('Toss by', 'Tirar antes de')} ${fmtRiceTime(row.tossByAt)}`}
                </div>
            )}

            <StatusLine row={row} state={state} open={open} now={shownNow} tx={tx} isEs={isEs} deleted={deleted} morningOk={morningOk} />

            {!compact && readings.length > 0 && (
                <div className="mt-0.5 text-[12px] text-dd-text-2">
                    {tx('Readings', 'Lecturas')}: {readings.map((x) => `${x.kind === 'morning' ? tx('morning ', 'mañana ') : ''}${riceReadingTime(x, row, isEs)} ${x.tempF}°F`).join(', ')}
                </div>
            )}
            {!compact && row.notes ? <div className="mt-0.5 text-[12px] text-dd-text-2">📝 {row.notes}</div> : null}

            {!compact && failed && (
                <div className="mt-1.5 rounded-lg border border-red-300 bg-red-50 p-2">
                    <div className="text-[12px] font-bold text-red-800">
                        {timedOut
                            ? tx('Printer timed out. Check whether a sticker came out.', 'La impresora no respondió. Revisa si salió una etiqueta.')
                            : tx("Sticker didn't print. Write it on tape.", 'La etiqueta no se imprimió. Escríbelo en cinta.')}
                    </div>
                    {fridgeRoute ? (
                        <>
                            <div className="text-3xl font-black text-red-800 tabular-nums">70F {stickerTime(row.seventyByAt)}</div>
                            <div className="text-3xl font-black text-red-800 tabular-nums">41F {stickerTime(row.fortyOneByAt)}</div>
                            <div className="text-3xl font-black text-red-800 tabular-nums">{tx('USE BY', 'USAR')} {stickerDay(row.useByDay)}</div>
                        </>
                    ) : (
                        <div className="text-3xl font-black text-red-800 tabular-nums">{tx('Toss by', 'Tirar antes de')} {stickerTime(row.tossByAt)}</div>
                    )}
                    {timedOut && (
                        <button type="button" onClick={() => actions.confirmPrinted(row)} disabled={busy || !!hold}
                            className="mt-1 w-full min-h-[44px] rounded-lg bg-white border-2 border-red-300 text-red-800 text-sm font-black active:scale-95 disabled:opacity-40">
                            {tx('It came out', 'Sí salió')}
                        </button>
                    )}
                </div>
            )}

            {!compact && flags.length > 0 && (
                <ul className="mt-1 space-y-0.5 text-[12px] font-bold text-orange-900">
                    {flags.map((f) => <li key={f.code}>⚑ {isEs ? f.es : f.en}</li>)}
                </ul>
            )}

            {hold && (
                <div className="mt-2 flex items-center gap-2 rounded-lg bg-gray-900 text-white px-3 py-2">
                    <span className="flex-1 text-sm font-bold">
                        {tx(CLOSE_LABELS[hold.kind]?.[0], CLOSE_LABELS[hold.kind]?.[1])}
                        {' · '}{tx('saving in', 'se guarda en')} {Math.max(1, Math.ceil((hold.until - Date.now()) / 1000))}s
                    </span>
                    <button type="button" onClick={() => actions.undoClose(row.id)}
                        className="min-h-[44px] px-4 rounded-lg bg-white text-gray-900 text-sm font-black active:scale-95">
                        {tx('Undo', 'Deshacer')}
                    </button>
                </div>
            )}

            {open && !hold && (
                <CloseButtons state={state} morningOk={morningOk} busy={busy} tx={tx} close={requestClose} setPanel={setPanel} />
            )}

            {panel === 'fridge' && (
                <ReadingForm mode="fridge" row={row} tx={tx} busy={busy} staffName={staffName} actions={actions} onDone={closePanel} />
            )}
            {panel === 'reading' && (
                <ReadingForm mode="reading" row={row} tx={tx} busy={busy} staffName={staffName} actions={actions} onDone={closePanel} />
            )}
            {panel === 'morning' && (
                <ReadingForm mode="morning" row={row} tx={tx} busy={busy} staffName={staffName} actions={actions} onDone={closePanel} />
            )}
            {panel === 'edit' && (
                <EditForm row={row} tx={tx} busy={busy} staffName={staffName} isLead={isLead} actions={actions} onDone={closePanel} onDenied={denyEdit} />
            )}
            {panel === 'delete' && (
                <DeleteForm row={row} tx={tx} busy={busy} staffName={staffName} isLead={isLead} actions={actions} onDone={closePanel} onDenied={denyDelete} />
            )}
            {panel === 'reprint' && (
                <ReprintForm row={row} tx={tx} busy={busy} actions={actions} onDone={closePanel} />
            )}
            {panel === 'history' && (
                <div className="mt-2 rounded-lg border border-violet-200 bg-violet-50 p-2 text-[12px] text-violet-950 space-y-0.5">
                    <div className="font-black">{tx('Edit history', 'Historial de cambios')}</div>
                    {edits.map((e, i) => <div key={`${e.at}-${e.field}-${i}`}>{riceEditText(e, isEs)}</div>)}
                </div>
            )}

            {denied && <p className="mt-1.5 text-[12px] font-bold text-red-700">{denied}</p>}

            {!compact && !deleted && !voided && (
                <div className="mt-1.5 flex flex-wrap items-center gap-x-3">
                    {open && (
                        <button type="button" onClick={tapReprint} disabled={busy || !!hold} className={`${LINK} inline-flex items-center gap-1`}>
                            <Printer size={12} /> {tx('Reprint', 'Reimprimir')}
                        </button>
                    )}
                    <button type="button" onClick={tapEdit} disabled={busy || !!hold} className={LINK}>
                        {tx('Edit', 'Editar')}
                    </button>
                    <button type="button" onClick={tapDelete} disabled={busy || !!hold} className={LINK}>
                        {tx('Printed by mistake: delete', 'Impreso por error: borrar')}
                    </button>
                </div>
            )}
            {compact && failed && (
                <div className="mt-1">
                    {timedOut && (
                        <>
                            <p className="text-[12px] font-bold text-red-800">
                                {tx('Printer timed out. Check whether a sticker came out.', 'La impresora no respondió. Revisa si salió una etiqueta.')}
                            </p>
                            <button type="button" onClick={() => actions.confirmPrinted(row)} disabled={busy || !!hold}
                                className="mt-1 w-full min-h-[44px] rounded-lg bg-white border-2 border-red-300 text-red-800 text-sm font-black active:scale-95 disabled:opacity-40">
                                {tx('It came out', 'Sí salió')}
                            </button>
                        </>
                    )}
                    <button type="button" onClick={tapReprint} disabled={busy || !!hold} className={`${LINK} inline-flex items-center gap-1`}>
                        <Printer size={12} /> {tx('Reprint', 'Reimprimir')}
                    </button>
                </div>
            )}
        </div>
    );
}

function StatusLine({ row, state, open, now, tx, isEs, deleted, morningOk }) {
    if (deleted) {
        return (
            <div className="mt-0.5 text-[13px] font-bold text-dd-text-2">
                {tx('Deleted', 'Borrado')} {fmtRiceTime(row.deletedAt)} — {row.deletedBy}: {row.deleteReason}
            </div>
        );
    }
    if (!open) {
        const red = row.status === RICE_STATUS.TOSSED && row.tossReason === 'morning_above_41';
        return (
            <>
                {red && <div className="mt-1 text-2xl font-black text-red-700">{tx('ABOVE 41F: TOSS IT', 'SOBRE 41F: TÍRALO')}</div>}
                <div className="mt-0.5 text-[13px] font-bold text-dd-text">{riceOutcomeText(row, isEs)}</div>
            </>
        );
    }
    const t = now.getTime();
    switch (state) {
        case 'tossNow':
            return <div className="mt-0.5 text-sm font-black text-red-700">{tx('PAST THE TOSS TIME', 'PASÓ LA HORA DE TIRAR')}</div>;
        case 'pastUseBy':
            return <div className="mt-0.5 text-sm font-black text-red-700">{tx('PAST ITS USE-BY: TOSS IT', 'PASÓ LA FECHA DE USO: TÍRALO')}</div>;
        case 'past70':
            return <div className="mt-0.5 text-sm font-black text-amber-800">{tx('Past its 70F time. Over 70F: toss it.', 'Pasó su hora de 70F. Sobre 70F: tíralo.')}</div>;
        case 'cooling':
            return <div className="mt-0.5 text-sm font-black text-sky-800">{tx('70F in', '70F en')} {fmtLeft(new Date(row.seventyByAt).getTime() - t)}</div>;
        case 'inFridge':
            return <div className="mt-0.5 text-sm font-black text-sky-800">{tx('In the fridge since', 'En el refri desde')} {fmtRiceTime(row.fridgedAt)}</div>;
        case 'morning':
            if (morningOk) {
                return <div className="mt-0.5 text-sm font-black text-dd-green-700">{tx(`Morning reading ${morningOk.tempF}F, ${fmtRiceTime(morningOk.at)}. OK to use.`, `Lectura de la mañana ${morningOk.tempF}F, ${fmtRiceTime(morningOk.at)}. Se puede usar.`)}</div>;
            }
            return <div className="mt-0.5 text-sm font-black text-sky-800">{tx('Take the morning reading before you use it.', 'Toma la lectura de la mañana antes de usarlo.')}</div>;
        default:
            return <div className="mt-0.5 text-sm font-black text-sky-800">{tx('Toss in', 'Tirar en')} {fmtLeft(new Date(row.tossByAt).getTime() - t)}</div>;
    }
}

function CloseButtons({ state, morningOk, busy, tx, close, setPanel }) {
    const used = (
        <button type="button" onClick={() => close('used')} disabled={busy} className={`${BTN} bg-dd-green-50 border border-dd-green/40 text-dd-green-700`}>
            <CheckCircle2 size={15} /> {tx('All Gone', 'Se acabó')}
        </button>
    );
    const tossed = (strong) => (
        <button type="button" onClick={() => close('tossed')} disabled={busy}
            className={`${BTN} ${strong ? 'bg-red-600 text-white' : 'bg-red-50 border border-red-200 text-red-700'}`}>
            <Trash2 size={15} /> {tx('Tossed', 'Tirado')}
        </button>
    );
    const reading = (
        <button type="button" onClick={() => setPanel('reading')} disabled={busy} className={`${BTN} bg-white border border-sky-300 text-sky-800`}>
            <Thermometer size={15} /> {tx('Reading', 'Lectura')}
        </button>
    );
    let buttons;
    switch (state) {
        case 'tossNow':
            // Three answers, because yes-or-no makes someone guess, or pick the
            // answer that looks clean, under their own name.
            buttons = (
                <>
                    <button type="button" onClick={() => close('saw_gone')} disabled={busy} className={`${BTN} bg-dd-green-50 border border-dd-green/40 text-dd-green-700`}>
                        {tx('I saw it gone in time', 'Lo vi acabarse a tiempo')}
                    </button>
                    {tossed(true)}
                    <button type="button" onClick={() => close('unknown')} disabled={busy} className={`${BTN} bg-white border border-dd-line text-dd-text`}>
                        {tx("Don't know, or used late", 'No sé, o se usó tarde')}
                    </button>
                </>
            );
            break;
        case 'cooling':
        case 'past70':
            buttons = (
                <>
                    <button type="button" onClick={() => setPanel('fridge')} disabled={busy} className={`${BTN} bg-sky-600 text-white`}>
                        <Snowflake size={15} /> {tx('Into Fridge', 'Al refri')}
                    </button>
                    {reading}
                    {tossed(false)}
                </>
            );
            break;
        case 'inFridge':
            buttons = (
                <>
                    {reading}
                    <button type="button" onClick={() => close('used')} disabled={busy} className={`${BTN} bg-dd-green-50 border border-dd-green/40 text-dd-green-700`}>
                        <CheckCircle2 size={15} /> {tx('Used', 'Usado')}
                    </button>
                    {tossed(false)}
                </>
            );
            break;
        case 'morning': {
            // Once today's reading has passed, Used is the main action.
            const probe = (
                <button type="button" onClick={() => setPanel('morning')} disabled={busy} className={`${BTN} ${morningOk ? 'bg-white border border-sky-300 text-sky-800' : 'bg-sky-600 text-white'}`}>
                    <Thermometer size={15} /> {tx('Morning Reading', 'Lectura de la mañana')}
                </button>
            );
            const usedIt = (
                <button type="button" onClick={() => close('used')} disabled={busy} className={`${BTN} ${morningOk ? 'bg-dd-green text-white' : 'bg-dd-green-50 border border-dd-green/40 text-dd-green-700'}`}>
                    <CheckCircle2 size={15} /> {tx('Used', 'Usado')}
                </button>
            );
            buttons = <>{morningOk ? <>{usedIt}{probe}</> : <>{probe}{usedIt}</>}{tossed(false)}</>;
            break;
        }
        case 'pastUseBy':
            buttons = tossed(true);
            break;
        default:
            buttons = <>{used}{tossed(false)}</>;
    }
    return <div className="flex flex-wrap gap-1.5 mt-2">{buttons}</div>;
}

// A reading a person took: number plus the time they took it. The number
// always starts blank. Into Fridge may leave it blank; the others need it. The
// time belongs to the reading, so it's only asked for with one: Into Fridge
// itself is stamped when it's saved. A morning reading above 41F closes the batch
// for good, so the form repeats the number for a yes first.
const RICE_CONFIRM_GUARD_MS = 500;  // a double tap on Save can't answer the yes
function ReadingForm({ mode, row, tx, busy, staffName, actions, onDone }) {
    const [temp, setTemp] = useState('');
    const [time, setTime] = useState(() => toInputTime(new Date()));
    const [error, setError] = useState(null);
    const [overAsked, setOverAsked] = useState(null);   // { tempF, at }
    const optional = mode === 'fridge';
    const t = parseRiceTemp(temp);
    const asking = mode === 'morning' && overAsked?.tempF === t && t > RICE_MAX_41F;
    const titles = {
        fridge: tx('Into the fridge now. Reading is optional.', 'Al refri ahora. La lectura es opcional.'),
        reading: tx('Add a reading', 'Agregar lectura'),
        morning: tx('Morning reading. Above 41F is a toss.', 'Lectura de la mañana. Sobre 41F se tira.'),
    };
    const save = () => {
        setError(null);
        if (temp.trim() !== '' && t == null) {
            setError(tx('Enter the reading as a number.', 'Escribe la lectura en número.'));
            return;
        }
        if (!optional && t == null) {
            setError(tx('Enter the reading from the probe.', 'Escribe la lectura del termómetro.'));
            return;
        }
        const nowAt = new Date();
        let at;
        if (t != null) {
            const [h, m] = String(time).split(':').map((x) => (x === '' ? NaN : Number(x)));
            if (!Number.isFinite(h) || !Number.isFinite(m)) {
                setError(tx('Enter the time of the reading.', 'Escribe la hora de la lectura.'));
                return;
            }
            at = new Date(nowAt);
            at.setHours(h, m, 0, 0);
            if (at.getTime() > nowAt.getTime() + 60000) {
                setError(tx('That time is in the future.', 'Esa hora es en el futuro.'));
                return;
            }
            // The box has no seconds, so the batch's own minute still counts.
            const made = new Date(riceMadeAt(row));
            made.setSeconds(0, 0);
            if (at.getTime() < made.getTime()) {
                setError(tx(`That time is before this batch was made (${fmtRiceTime(riceMadeAt(row))}).`, `Esa hora es antes de que se hiciera este lote (${fmtRiceTime(riceMadeAt(row))}).`));
                return;
            }
        }
        if (mode === 'morning' && t > RICE_MAX_41F) {
            if (!asking) { setOverAsked({ tempF: t, at: Date.now() }); return; }
            if (Date.now() - overAsked.at < RICE_CONFIRM_GUARD_MS) return;
        }
        if (mode === 'fridge') {
            actions.run(row, () => markRiceIntoFridge(row, staffName, { tempF: t, at }), tx('Logged into the fridge', 'Registrado al refri'), onDone);
        } else if (mode === 'morning') {
            const over = t > RICE_MAX_41F;
            actions.run(row, () => logRiceMorningReading(row, staffName, { tempF: t, at }), over ? null : tx('Morning reading saved', 'Lectura de la mañana guardada'), () => {
                if (over) actions.addTossAlert(row, t);
                onDone();
            });
        } else {
            actions.run(row, () => addRiceReading(row, staffName, { tempF: t, at }), tx('Reading saved', 'Lectura guardada'), onDone);
        }
    };
    const warn41 = mode !== 'morning' && t != null && t > RICE_MAX_41F && new Date() >= new Date(row.fortyOneByAt);
    const warn70 = !warn41 && mode !== 'morning' && t != null && t > RICE_MAX_70F && new Date() >= new Date(row.seventyByAt);
    return (
        <div className="mt-2 rounded-lg border border-sky-200 bg-sky-50 p-2 space-y-2">
            <div className="text-[13px] font-black text-sky-950">{titles[mode]}</div>
            <div className="flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-1 text-[13px] font-bold">
                    °F
                    <input type="number" inputMode="numeric" aria-label={tx('Reading in degrees F', 'Lectura en grados F')}
                        value={temp} onChange={(e) => setTemp(e.target.value)} className={`${INPUT} w-24`} />
                </label>
                {(!optional || temp.trim() !== '') && (
                    <label className="flex items-center gap-1 text-[13px] font-bold">
                        {tx('Time of reading', 'Hora de la lectura')}
                        <input type="time" aria-label={tx('Time of the reading', 'Hora de la lectura')}
                            value={time} onChange={(e) => setTime(e.target.value)} className={INPUT} />
                    </label>
                )}
            </div>
            {warn70 && <p className="text-[12px] font-bold text-red-700">{tx('Above 70F past its 70F time: toss it.', 'Sobre 70F pasada su hora de 70F: tíralo.')}</p>}
            {warn41 && <p className="text-[12px] font-bold text-red-700">{tx('Above 41F past its 41F time: toss it.', 'Sobre 41F pasada su hora de 41F: tíralo.')}</p>}
            {error && <p className="text-[12px] font-bold text-red-700">{error}</p>}
            {asking && (
                <p role="alert" className="rounded-lg bg-red-100 border border-red-300 p-2 text-sm font-black text-red-800">
                    {tx(`${t}F is above 41F. Saving logs this batch as tossed, and it can't be undone. Check the number.`,
                        `${t}F está sobre 41F. Al guardar, este lote queda como tirado y no se puede deshacer. Revisa el número.`)}
                </p>
            )}
            <div className="flex gap-1.5">
                <button type="button" onClick={save} disabled={busy} className={`${BTN} ${asking ? 'bg-red-600' : 'bg-sky-600'} text-white`}>
                    {asking ? tx(`Yes, ${t}F: toss it`, `Sí, ${t}F: tirarlo`) : tx('Save', 'Guardar')}
                </button>
                <button type="button" onClick={onDone} className={`${BTN} bg-white border border-dd-line text-dd-text`}>{tx('Cancel', 'Cancelar')}</button>
            </div>
        </div>
    );
}

function ReprintForm({ row, tx, busy, actions, onDone }) {
    const [count, setCount] = useState(() => riceReprintCopies(row));
    const timedOut = lastPrintFailure(row)?.error === 'printer timeout';
    return (
        <div className="mt-2 rounded-lg border border-sky-200 bg-sky-50 p-2 space-y-2">
            {timedOut && (
                <p className="text-[12px] font-bold text-red-800">
                    {tx('The last job timed out, so some may have printed. Check first, then print only what is missing.',
                        'El último trabajo no respondió, así que algunas pudieron imprimirse. Revisa primero e imprime solo las que faltan.')}
                </p>
            )}
            <ReprintCount value={count} onChange={setCount} tx={tx} />
            <div className="flex gap-1.5">
                <button type="button" onClick={() => { onDone(); actions.reprint(row, count); }} disabled={busy} className={`${BTN} bg-sky-600 text-white`}>
                    {tx(`Print ${count}`, `Imprimir ${count}`)}
                </button>
                <button type="button" onClick={onDone} className={`${BTN} bg-white border border-dd-line text-dd-text`}>{tx('Cancel', 'Cancelar')}</button>
            </div>
        </div>
    );
}

function EditForm({ row, tx, busy, staffName, isLead, actions, onDone, onDenied }) {
    const [temp, setTemp] = useState(Number.isFinite(row.startTempF) ? String(row.startTempF) : '');
    const [pans, setPans] = useState(Number.isFinite(row.pans) ? row.pans : null);
    const [outcome, setOutcome] = useState('');
    const [notes, setNotes] = useState(row.notes || '');
    const [error, setError] = useState(null);
    const save = () => {
        setError(null);
        const at = new Date();
        // The form may have sat open past the 10 minutes.
        const allowed = riceEditPolicy(row, { now: at, isLead });
        if (!allowed.canEdit) { onDenied(allowed); return; }
        const draft = { startTempF: temp.trim(), notes, ...(pans != null ? { pans } : {}), ...(outcome ? { outcome } : {}) };
        const check = buildRiceEdit(row, draft, staffName, at);
        if (check.error) {
            setError(check.error === 'reading'
                ? tx('Enter the reading as a number.', 'Escribe la lectura en número.')
                : tx(`Pans must be 1 to ${RICE_MAX_COPIES}.`, `Las bandejas deben ser de 1 a ${RICE_MAX_COPIES}.`));
            return;
        }
        if (check.entries.length === 0) { onDone(); return; }
        actions.run(row, () => editRiceBatch(row, draft, staffName, at), tx('Edit saved', 'Cambio guardado'), onDone);
    };
    // Past the toss time, the same three answers as the row's own buttons, so
    // an edit can't turn a late batch into a clean "All gone".
    const lateNow = !isRiceFridgeRoute(row) && !row.fridgedAt && Date.now() >= new Date(row.tossByAt).getTime();
    const outcomes = [
        lateNow ? ['saw_gone', tx('I saw it gone in time', 'Lo vi acabarse a tiempo')] : ['used', tx('All gone', 'Se acabó')],
        ['tossed', tx('Tossed', 'Tirado')],
        ['unknown', tx("Don't know, or used late", 'No sé, o se usó tarde')],
    ].filter(([v]) => v !== row.status && !(v === 'saw_gone' && riceSawGone(row)));
    return (
        <div className="mt-2 rounded-lg border border-dd-line bg-gray-50 p-2 space-y-2">
            <p className="text-[12px] font-bold text-dd-text-2">
                {tx("Made time and route can't change, because the sticker already printed them. If they're wrong, delete this ticket and print a new one.",
                    'La hora y la ruta no se pueden cambiar porque la etiqueta ya las imprimió. Si están mal, borra este ticket e imprime otro.')}
            </p>
            <div className="flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-1 text-[13px] font-bold">
                    {tx('Reading °F', 'Lectura °F')}
                    <input type="number" inputMode="numeric" aria-label={tx('Edit the reading', 'Editar la lectura')}
                        value={temp} onChange={(e) => setTemp(e.target.value)} className={`${INPUT} w-24`} />
                </label>
                {pans != null && (
                    <div className="flex items-center gap-1 text-[13px] font-bold">
                        {tx('Pans', 'Bandejas')}
                        <button type="button" aria-label={tx('Fewer pans', 'Menos bandejas')} onClick={() => setPans((c) => Math.max(1, c - 1))} className="w-11 h-11 rounded-full bg-white border border-dd-line font-black">−</button>
                        <span className="w-6 text-center tabular-nums">{pans}</span>
                        <button type="button" aria-label={tx('More pans', 'Más bandejas')} onClick={() => setPans((c) => Math.min(RICE_MAX_COPIES, c + 1))} className="w-11 h-11 rounded-full bg-white border border-dd-line font-black">+</button>
                    </div>
                )}
            </div>
            <label className="block text-[13px] font-bold">
                {tx('How it ended', 'Cómo terminó')}
                <select aria-label={tx('How it ended', 'Cómo terminó')} value={outcome} onChange={(e) => setOutcome(e.target.value)} className={`${INPUT} block w-full mt-1`}>
                    <option value="">{tx('Leave as is', 'Dejar igual')}</option>
                    {outcomes.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
                </select>
            </label>
            <label className="block text-[13px] font-bold">
                {tx('Note', 'Nota')}
                <input type="text" maxLength={200} aria-label={tx('Note', 'Nota')} value={notes} onChange={(e) => setNotes(e.target.value)} className={`${INPUT} block w-full mt-1`} />
            </label>
            {error && <p className="text-[12px] font-bold text-red-700">{error}</p>}
            <div className="flex gap-1.5">
                <button type="button" onClick={save} disabled={busy} className={`${BTN} bg-dd-green text-white`}>{tx('Save edit', 'Guardar cambio')}</button>
                <button type="button" onClick={onDone} className={`${BTN} bg-white border border-dd-line text-dd-text`}>{tx('Cancel', 'Cancelar')}</button>
            </div>
        </div>
    );
}

function DeleteForm({ row, tx, busy, staffName, isLead, actions, onDone, onDenied }) {
    const [reason, setReason] = useState('');
    const [windowClosed, setWindowClosed] = useState(false);
    const needsReason = windowClosed || riceDeletePolicy(row, { now: new Date(), isLead }).needsReason;
    const ready = !needsReason || reason.trim().length > 0;
    const go = () => {
        // The form may have sat open past the 10 minutes, or past the batch's limit.
        const at = new Date();
        const allowed = riceDeletePolicy(row, { now: at, isLead });
        if (!allowed.canDelete) { onDenied(allowed); return; }
        if (allowed.needsReason && !reason.trim()) { setWindowClosed(true); return; }
        actions.run(row, () => softDeleteRiceBatch(row, staffName, reason, at), tx(`Ticket #${row.batchNo} deleted`, `Ticket #${row.batchNo} borrado`), onDone);
    };
    return (
        <div className="mt-2 rounded-lg border border-red-200 bg-red-50 p-2 space-y-2">
            <p className="text-[13px] font-bold text-red-900">
                {tx(`Delete ticket #${row.batchNo}? It leaves today's list but stays on file, and the number isn't reused.`,
                    `¿Borrar el ticket #${row.batchNo}? Sale de la lista de hoy pero queda guardado, y el número no se vuelve a usar.`)}
            </p>
            {needsReason && (
                <label className="block text-[13px] font-bold text-red-900">
                    {tx('Reason', 'Razón')}
                    <input type="text" maxLength={200} aria-label={tx('Reason for deleting', 'Razón para borrar')}
                        value={reason} onChange={(e) => setReason(e.target.value)} className={`${INPUT} block w-full mt-1`} />
                </label>
            )}
            <div className="flex gap-1.5">
                <button type="button" onClick={go} disabled={busy || !ready} className={`${BTN} bg-red-600 text-white`}>{tx('Yes, delete', 'Sí, borrar')}</button>
                <button type="button" onClick={onDone} className={`${BTN} bg-white border border-dd-line text-dd-text`}>{tx('Cancel', 'Cancelar')}</button>
            </div>
        </div>
    );
}
