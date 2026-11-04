// useRiceBatchActions — closing and reprinting rice batches, shared by the
// rice screen and the Rice Log (2026-11-03).
//
// Busy is PER BATCH and short: a write only guards against a double tap, then
// lets go. An offline write's promise doesn't settle until the connection is
// back, and the toss of an expired batch has to stay one tap away, on this
// batch and every other one. A reprint stays busy until the printer answers.
//
// All Gone and Tossed hold their write for 15 seconds with an Undo, so no
// status ever has to go back to open. If the app dies inside the window the
// batch stays open, which is the safe failure. If the cook just leaves the
// screen, the close goes through: they tapped it and meant it. Nothing else
// runs on a batch during its hold, and the close itself never checks busy, so
// a tapped close can't quietly vanish.
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from '../toast';
import { RICE_UNDO_MS, closeRiceBatch, confirmRicePrinted, isRiceOpen, printRiceSticker, riceReprintCopies } from '../data/riceLog';

const DOUBLE_TAP_GUARD_MS = 800;

const PRINT_ERRORS = {
    no_printer_configured: ['No printer set up for this store. Ask a manager.', 'No hay impresora para esta tienda. Pregunta a un gerente.'],
    printer_disabled: ['The printer is turned off in settings.', 'La impresora está desactivada en la configuración.'],
    'printer timeout': ['The printer timed out. Check whether a sticker came out before you reprint.', 'La impresora no respondió a tiempo. Revisa si salió una etiqueta antes de reimprimir.'],
    printer_rejected: ['The printer rejected the sticker. Check the paper and cover.', 'La impresora rechazó la etiqueta. Revisa el papel y la tapa.'],
    web_unsupported: ['This device can\'t reach the printer. Print from the store iPad.', 'Este aparato no llega a la impresora. Imprime desde el iPad de la tienda.'],
};

export function ricePrintMessage(res, isEs = false) {
    const msg = PRINT_ERRORS[res?.error];
    if (msg) return isEs ? msg[1] : msg[0];
    return isEs
        ? 'La etiqueta no se imprimió. Toca Reimprimir en el lote.'
        : 'Sticker did not print. Tap Reprint on the batch.';
}

const CLOSE_WORDS = {
    used: ['Logged as all gone', 'Registrado: se acabó'],
    saw_gone: ['Logged: saw it gone in time', 'Registrado: lo vi acabarse a tiempo'],
    tossed: ['Logged as tossed', 'Registrado como tirado'],
    unknown: ["Logged: don't know, or used late", 'Registrado: no se sabe, o se usó tarde'],
};

export function useRiceBatchActions({ location, staffName, language }) {
    const isEs = language === 'es';
    const tx = useCallback((en, es) => (isEs ? es : en), [isEs]);
    const [busyIds, setBusyIds] = useState(() => new Set());
    // The ref changes right away, so a second tap can't get in before a redraw.
    const busyRef = useRef(busyIds);
    const setBusy = useCallback((id, on) => {
        const next = new Set(busyRef.current);
        if (on) next.add(id); else next.delete(id);
        busyRef.current = next;
        setBusyIds(next);
    }, []);

    // Writes queue locally the moment they're issued, and the server's answer
    // can take minutes offline, so the screen never waits for it. A rejection
    // rolls the local change back and says so.
    const write = useCallback((row, fn, okMsg, onQueued) => {
        let p;
        try { p = fn(); } catch (e) {
            console.warn('rice_log update failed:', e);
            toast(tx('Could not save. Try again.', 'No se pudo guardar. Intenta de nuevo.'), { kind: 'error' });
            return false;
        }
        setBusy(row.id, true);
        setTimeout(() => setBusy(row.id, false), DOUBLE_TAP_GUARD_MS);
        if (okMsg) toast(okMsg, { kind: 'success', duration: 2000 });
        onQueued?.();
        Promise.resolve(p).catch((e) => {
            console.warn('rice_log update failed:', e);
            // The rules refuse a close on a batch another device already
            // closed, and trying again can't work. They don't say why, so
            // this doesn't claim more than it knows.
            toast(e?.code === 'permission-denied'
                ? tx(`Batch #${row.batchNo} did not save. It may already be closed on another device. Check the Rice Log.`, `El lote #${row.batchNo} no se guardó. Puede que ya esté cerrado en otro aparato. Revisa el registro.`)
                : tx(`Batch #${row.batchNo} did not save. Try again.`, `El lote #${row.batchNo} no se guardó. Intenta de nuevo.`), { kind: 'error', duration: 6000 });
        });
        return true;
    }, [setBusy, tx]);

    // rowId -> { kind, until }. The write itself waits on the timer.
    const [pending, setPending] = useState({});
    const held = useRef(new Map());     // rowId -> { timer, commit }
    const writeRef = useRef(write);
    writeRef.current = write;
    const staffRef = useRef(staffName);
    staffRef.current = staffName;
    const txRef = useRef(tx);
    txRef.current = tx;

    const dropPending = useCallback((rowId) => {
        held.current.delete(rowId);
        setPending((prev) => {
            if (!prev[rowId]) return prev;
            const next = { ...prev };
            delete next[rowId];
            return next;
        });
    }, []);

    const requestClose = useCallback((row, kind) => {
        if (busyRef.current.has(row.id) || held.current.has(row.id)) return;
        const at = new Date();
        const by = staffRef.current;
        const commit = () => {
            dropPending(row.id);
            const words = CLOSE_WORDS[kind] || CLOSE_WORDS.used;
            writeRef.current(row, () => closeRiceBatch(row, kind, by, at), txRef.current(words[0], words[1]));
        };
        held.current.set(row.id, { timer: setTimeout(commit, RICE_UNDO_MS), commit });
        setPending((prev) => ({ ...prev, [row.id]: { kind, until: at.getTime() + RICE_UNDO_MS } }));
    }, [dropPending]);

    const undoClose = useCallback((rowId) => {
        const h = held.current.get(rowId);
        if (h) clearTimeout(h.timer);
        dropPending(rowId);
    }, [dropPending]);

    // Leaving the screen sends what's still held.
    useEffect(() => () => {
        for (const { timer, commit } of [...held.current.values()]) {
            clearTimeout(timer);
            commit();
        }
    }, []);

    // The Undo countdown.
    const [, setTick] = useState(0);
    const anyPending = Object.keys(pending).length > 0;
    useEffect(() => {
        if (!anyPending) return undefined;
        const id = setInterval(() => setTick((t) => t + 1), 1000);
        return () => clearInterval(id);
    }, [anyPending]);

    const run = useCallback((row, fn, okMsg, onQueued) => {
        if (busyRef.current.has(row.id) || held.current.has(row.id)) return false;
        return write(row, fn, okMsg, onQueued);
    }, [write]);

    // Never for a batch that's closed or deleted: nothing should get taped up
    // under a ticket the log no longer shows.
    const reprint = useCallback(async (row, copies = 1) => {
        if (!isRiceOpen(row) || busyRef.current.has(row.id) || held.current.has(row.id)) return null;
        setBusy(row.id, true);
        try {
            const res = await printRiceSticker({ row, location, staffName: staffRef.current, copies });
            if (res.ok) toast(tx('Sticker reprinted', 'Etiqueta reimpresa'), { kind: 'success', duration: 2000 });
            else if (res.error !== 'cancelled') toast(ricePrintMessage(res, isEs), { kind: 'error', duration: 6000 });
            return res;
        } finally {
            setBusy(row.id, false);
        }
    }, [isEs, location, setBusy, tx]);

    // The reply timed out but the sticker came out. Nothing prints.
    const confirmPrinted = useCallback((row, copies = riceReprintCopies(row)) => run(
        row,
        () => confirmRicePrinted(row, staffRef.current, copies),
        tx('Noted: the sticker came out', 'Anotado: la etiqueta sí salió'),
    ), [run, tx]);

    // A high morning reading closes the batch, so its row leaves the list right
    // when the cook needs the instruction. This stays on screen until dismissed.
    const [tossAlerts, setTossAlerts] = useState([]);   // [{ id, batchNo, tempF }]
    const addTossAlert = useCallback((row, tempF) => {
        setTossAlerts((prev) => [...prev.filter((a) => a.id !== row.id), { id: row.id, batchNo: row.batchNo, tempF }]);
    }, []);
    const dismissTossAlert = useCallback((id) => {
        setTossAlerts((prev) => prev.filter((a) => a.id !== id));
    }, []);

    return { busyIds, pending, run, requestClose, undoClose, reprint, confirmPrinted, tossAlerts, addTossAlert, dismissTossAlert };
}
