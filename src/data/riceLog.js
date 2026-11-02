// riceLog.js — fried-rice rice cooling log + batch stickers.
//
// Andrew 2026-11-02: the health department wants a log for the rice that
// becomes fried rice. Process: cook the rice, season + oil it, cool it at
// room temperature (cold rice fries better), 6–7 batches a day. Every batch
// gets a sticker (COOKED time / FRIDGE BY / TOSS) and a log row the
// inspector can read: who cooked it, when, and what happened to it.
//
// Clock (FDA Food Code, both measured from when cooking finished):
//   • FRIDGE BY = cooked + 2h — cooling stage 1 (3-501.14): rice must be
//     at 70°F or below within 2 hours, then refrigerated to finish cooling.
//   • TOSS      = cooked + 4h — time-as-control limit (3-501.19): rice held
//     out of temperature control must be used or discarded within 4 hours.
// One sticker carries both deadlines; the log records which path the
// batch took (used / into the fridge with a temp / tossed).
//
// /rice_log/{autoId} — one doc per batch, never deleted (rules block +
// carve-out in firestore.rules). Mistakes are voided, not erased.

import { db } from '../firebase';
import {
    collection, query, where, onSnapshot, doc,
    setDoc as _fsSetDoc, updateDoc as _fsUpdateDoc, arrayUnion, serverTimestamp,
} from 'firebase/firestore';
import { watchdogWrite } from './firestoreRevive';
import { printPrepLabel } from './labelPrinting';

const setDoc = (...a) => watchdogWrite(_fsSetDoc(...a));
const updateDoc = (...a) => watchdogWrite(_fsUpdateDoc(...a));

export const RICE_LOG_COLLECTION = 'rice_log';
export const RICE_FRIDGE_BY_HOURS = 2;
export const RICE_TOSS_HOURS = 4;
// Sticker section kind — the sticker page routes taps on this kind to the
// rice log instead of the generic print modal.
export const RICE_BATCH_KIND = 'rice_batch';
export const RICE_STICKER_NAME_EN = 'Fried Rice Rice';
export const RICE_STICKER_NAME_ES = 'Arroz para Arroz Frito';

export const RICE_STATUS = Object.freeze({
    COOLING: 'cooling',
    FRIDGE: 'fridge',
    USED: 'used',
    TOSSED: 'tossed',
    VOID: 'void',
});

const HOUR = 3600000;

export const riceDayStr = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// Deadlines for a batch that finished cooking at `cookedAt` (a Date).
export function riceDeadlines(cookedAt) {
    const t = cookedAt.getTime();
    return {
        fridgeByAt: new Date(t + RICE_FRIDGE_BY_HOURS * HOUR),
        tossByAt: new Date(t + RICE_TOSS_HOURS * HOUR),
    };
}

// Next batch number for the day: one past the highest already logged.
// Voided batches still hold their number, so numbers never repeat.
export function nextBatchNo(rows) {
    let max = 0;
    for (const r of rows || []) {
        const n = Number(r?.batchNo);
        if (Number.isFinite(n) && n > max) max = n;
    }
    return max + 1;
}

// What the batch needs from the cook right now. Open batches only —
// finished ones (used / fridge / tossed / void) return their status.
//   'ok'        — before fridge-by: use it, fridge it, or toss it
//   'fridgeLate'— past fridge-by, before toss: use it or toss it
//   'tossNow'   — past the 4-hour limit: toss it
export function riceBatchState(row, now = new Date()) {
    if (!row) return 'ok';
    if (row.status && row.status !== RICE_STATUS.COOLING) return row.status;
    const n = now.getTime();
    if (n >= new Date(row.tossByAt).getTime()) return 'tossNow';
    if (n >= new Date(row.fridgeByAt).getTime()) return 'fridgeLate';
    return 'ok';
}

// The new-batch log doc. Times are ISO strings (sortable, readable in the
// printed log); createdAt is the server clock for audit.
export function buildRiceBatchDoc({ cookedAt, location, cookedBy, batchNo, notes = '' }) {
    const { fridgeByAt, tossByAt } = riceDeadlines(cookedAt);
    return {
        location,
        cookDay: riceDayStr(cookedAt),
        batchNo,
        cookedAt: cookedAt.toISOString(),
        fridgeByAt: fridgeByAt.toISOString(),
        tossByAt: tossByAt.toISOString(),
        cookedBy: String(cookedBy || 'unknown').slice(0, 60),
        status: RICE_STATUS.COOLING,
        stickerCount: 0,
        prints: [],
        notes: String(notes || '').slice(0, 200),
        createdAt: serverTimestamp(),
    };
}

// Extra sticker lines (rendered by buildLabelPayload in the label's own
// time format). The COOKED date/time and the giant TOSS time come from the
// standard hour-clock label; these add the batch number + fridge deadline.
export function riceStickerLines(row) {
    return [
        { en: 'BATCH', es: 'LOTE', text: `#${row.batchNo}` },
        { en: 'FRIDGE BY', es: 'REFRIGERAR', at: new Date(row.fridgeByAt) },
    ];
}

export function subscribeRiceLog(location, cookDay, onRows, onError) {
    const q = query(
        collection(db, RICE_LOG_COLLECTION),
        where('location', '==', location),
        where('cookDay', '==', cookDay),
    );
    return onSnapshot(q, (snap) => {
        const rows = [];
        snap.forEach((d) => rows.push({ id: d.id, ...d.data() }));
        rows.sort((a, b) => String(a.cookedAt).localeCompare(String(b.cookedAt)));
        onRows(rows);
    }, (err) => {
        console.warn('rice_log subscription failed:', err);
        onError?.(err);
    });
}

// Print a batch sticker. Returns the printPrepLabel result and appends the
// attempt to the batch's print history (success or failure — the inspector
// log shows every sticker that went out).
export async function printRiceSticker({ row, location, staffName, language, copies = 1 }) {
    const res = await printPrepLabel({
        location,
        recipe: {
            titleEn: RICE_STICKER_NAME_EN,
            titleEs: RICE_STICKER_NAME_ES,
            kind: RICE_BATCH_KIND,
            allergens: [],
            ingredientsEn: [],
            ingredientsEs: [],
            category: 'Prep',
        },
        preppedBy: row.cookedBy || staffName,
        byName: staffName,
        shelfLifeHours: RICE_TOSS_HOURS,
        prepDate: new Date(row.cookedAt),
        extraMetaLines: riceStickerLines(row),
        language,
        copies,
        source: 'ricelog',
    }).catch((e) => ({ ok: false, error: e?.message || 'print_failed' }));
    const entry = {
        at: new Date().toISOString(),
        by: String(staffName || 'unknown').slice(0, 60),
        copies,
        ok: !!res.ok,
        ...(res.ok ? {} : { error: String(res.error || 'print_failed').slice(0, 80) }),
    };
    updateDoc(doc(db, RICE_LOG_COLLECTION, row.id), {
        prints: arrayUnion(entry),
        ...(res.ok ? { stickerCount: (Number(row.stickerCount) || 0) + copies } : {}),
    }).catch((e) => console.warn('rice_log print entry failed:', e));
    return res;
}

// Log a new batch and print its sticker. The log write is fired first and
// never waits on the server (kitchen Wi-Fi drops; the sticker must still
// print) — Firestore queues it and the row shows up immediately.
export async function startRiceBatch({ cookedAt, location, staffName, language, batchNo, copies = 1 }) {
    const ref = doc(collection(db, RICE_LOG_COLLECTION));
    const data = buildRiceBatchDoc({ cookedAt, location, cookedBy: staffName, batchNo });
    const logWrite = setDoc(ref, data).catch((e) => {
        console.warn('rice_log create failed:', e);
        return e;
    });
    const row = { id: ref.id, ...data, stickerCount: 0 };
    const res = await printRiceSticker({ row, location, staffName, language, copies });
    const logErr = await Promise.race([logWrite, new Promise((r) => setTimeout(() => r(null), 4000))]);
    return { res, id: ref.id, logFailed: logErr instanceof Error };
}

// Outcome writes. Each stamps who/when; the rules keep the batch identity
// (location / day / number / cooked time) frozen.
export function markRiceUsed(row, staffName) {
    return updateDoc(doc(db, RICE_LOG_COLLECTION, row.id), {
        status: RICE_STATUS.USED,
        usedAt: new Date().toISOString(),
        usedBy: String(staffName || 'unknown').slice(0, 60),
    });
}

export function markRiceFridge(row, staffName, tempF) {
    const t = Number(tempF);
    return updateDoc(doc(db, RICE_LOG_COLLECTION, row.id), {
        status: RICE_STATUS.FRIDGE,
        fridgedAt: new Date().toISOString(),
        fridgedBy: String(staffName || 'unknown').slice(0, 60),
        ...(Number.isFinite(t) && tempF !== '' && tempF != null ? { fridgeTempF: Math.round(t) } : {}),
    });
}

export function markRiceTossed(row, staffName, now = new Date()) {
    const late = now.getTime() >= new Date(row.tossByAt).getTime();
    return updateDoc(doc(db, RICE_LOG_COLLECTION, row.id), {
        status: RICE_STATUS.TOSSED,
        tossedAt: now.toISOString(),
        tossedBy: String(staffName || 'unknown').slice(0, 60),
        tossReason: late ? 'past_4h' : 'chose_to_toss',
    });
}

export function markRiceVoid(row, staffName) {
    return updateDoc(doc(db, RICE_LOG_COLLECTION, row.id), {
        status: RICE_STATUS.VOID,
        voidedAt: new Date().toISOString(),
        voidedBy: String(staffName || 'unknown').slice(0, 60),
    });
}

// ── Printable inspector log ─────────────────────────────────────────
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

export function fmtRiceTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return '';
    let h = d.getHours();
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return `${h}:${String(d.getMinutes()).padStart(2, '0')} ${ampm}`;
}

// What happened to the batch, in plain words, for the log's last column.
export function riceOutcomeText(row, isEs = false) {
    const tx = (en, es) => (isEs ? es : en);
    switch (row.status) {
        case RICE_STATUS.USED:
            return `${tx('Used for fried rice', 'Usado para arroz frito')} ${fmtRiceTime(row.usedAt)} — ${row.usedBy || ''}`;
        case RICE_STATUS.FRIDGE:
            return `${tx('Into fridge', 'Al refrigerador')} ${fmtRiceTime(row.fridgedAt)}`
                + (row.fridgeTempF != null ? ` @ ${row.fridgeTempF}°F` : '')
                + ` — ${row.fridgedBy || ''}`;
        case RICE_STATUS.TOSSED:
            return `${tx('Tossed', 'Tirado')} ${fmtRiceTime(row.tossedAt)} — ${row.tossedBy || ''}`
                + (row.tossReason === 'past_4h' ? tx(' (4-hour limit)', ' (límite de 4 horas)') : '');
        case RICE_STATUS.VOID:
            return `${tx('Voided (printed by mistake)', 'Anulado (impreso por error)')} — ${row.voidedBy || ''}`;
        default:
            return tx('Still cooling / in use', 'Enfriando / en uso');
    }
}

export function buildRiceLogHtml({ rows, cookDay, locationLabel, isEs = false }) {
    const tx = (en, es) => (isEs ? es : en);
    const body = (rows || []).map((r) => `
        <tr class="${r.status === RICE_STATUS.VOID ? 'void' : ''}">
            <td>#${esc(r.batchNo)}</td>
            <td>${esc(fmtRiceTime(r.cookedAt))}</td>
            <td>${esc(r.cookedBy)}</td>
            <td>${esc(fmtRiceTime(r.fridgeByAt))}</td>
            <td>${esc(fmtRiceTime(r.tossByAt))}</td>
            <td>${esc(riceOutcomeText(r, isEs))}</td>
            <td>${esc((r.prints || []).filter((p) => p.ok).reduce((n, p) => n + (Number(p.copies) || 1), 0))}</td>
        </tr>`).join('');
    return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(tx('Rice Cooling Log', 'Registro de Enfriamiento de Arroz'))} ${esc(cookDay)}</title>
<style>
  body { font-family: -apple-system, Helvetica, Arial, sans-serif; margin: 24px; color: #111; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { font-size: 12px; color: #444; margin-bottom: 14px; line-height: 1.5; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { border: 1px solid #999; padding: 6px 8px; text-align: left; vertical-align: top; }
  th { background: #eee; }
  tr.void td { color: #888; text-decoration: line-through; }
  .empty { padding: 24px; text-align: center; color: #666; }
  .no-print { margin-bottom: 14px; }
  .no-print button { font-size: 14px; padding: 8px 14px; margin-right: 8px; }
  @media print { .no-print { display: none; } body { margin: 10mm; } }
</style></head><body>
<div class="no-print"><button onclick="window.print()">🖨 ${esc(tx('Print', 'Imprimir'))}</button></div>
<h1>DD Mau — ${esc(tx('Fried Rice Rice Cooling Log', 'Registro de Enfriamiento — Arroz para Arroz Frito'))}</h1>
<div class="sub">
  ${esc(locationLabel)} · ${esc(cookDay)}<br>
  ${esc(tx(
        `Rice is cooked, seasoned + oiled, then cooled at room temperature for fried rice. Fridge by = ${RICE_FRIDGE_BY_HOURS} hours after cooking (cooled to 70°F or below, then refrigerated). Toss = ${RICE_TOSS_HOURS} hours after cooking if not used or refrigerated.`,
        `El arroz se cocina, se sazona y se le pone aceite, y se enfría a temperatura ambiente para arroz frito. Refrigerar = ${RICE_FRIDGE_BY_HOURS} horas después de cocinar (a 70°F o menos, luego al refrigerador). Tirar = ${RICE_TOSS_HOURS} horas después de cocinar si no se usó ni se refrigeró.`,
    ))}
</div>
<table>
  <thead><tr>
    <th>${esc(tx('Batch', 'Lote'))}</th>
    <th>${esc(tx('Done cooking', 'Terminó de cocinar'))}</th>
    <th>${esc(tx('Cooked by', 'Cocinado por'))}</th>
    <th>${esc(tx('Fridge by', 'Refrigerar antes de'))}</th>
    <th>${esc(tx('Toss at', 'Tirar a las'))}</th>
    <th>${esc(tx('What happened', 'Qué pasó'))}</th>
    <th>${esc(tx('Stickers', 'Etiquetas'))}</th>
  </tr></thead>
  <tbody>${body || `<tr><td colspan="7" class="empty">${esc(tx('No rice batches logged this day.', 'No hay lotes registrados este día.'))}</td></tr>`}</tbody>
</table>
</body></html>`;
}
