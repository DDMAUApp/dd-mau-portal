// queuedAdds.js — standing "extra pay" queue for the payroll wizard.
//
// (2026-08-10, Andrew: "i also want to be able the extra pay section so we
// can update as we need before we run payroll so we dont forget".)
//
// Pay-add line items used to exist ONLY inside a run — there was nowhere to
// write down "advance $100 to X, check #204" on a Tuesday mid-period, so it
// lived in someone's head until payroll day. This queue is that place:
//
//   • Lives at /config/payroll_queued_adds, editable any time the payroll
//     panel is unlocked (same owner password gate).
//   • Item shape mirrors the run's adjustment rows exactly, so seeding a
//     run is a field-for-field copy — same types, same validation.
//   • When a NEW period is imported, unconsumed items are copied into the
//     run's Pay Adds step and marked consumedIn=<period>. Same-period
//     re-imports never re-seed (PH1 keeps the run's own rows).
//   • Consumed items stay in the doc (recent ones) as an audit trail with
//     a Requeue path in the UI — a scrapped run doesn't lose the reminder.

import {
    doc, getDoc as _getDoc, setDoc as _setDoc, serverTimestamp,
} from 'firebase/firestore';
import { db } from '../../firebase';
import { watchdogWrite, watchdogRead } from '../firestoreRevive';

const QUEUE_PATH = ['config', 'payroll_queued_adds'];
// Keep this many consumed items as history; older ones fall off on save.
export const CONSUMED_KEEP = 20;

// ── store IO ───────────────────────────────────────────────────────────
/** Tolerant load: [] when the doc doesn't exist; {__error:true} on failure. */
export async function loadQueuedAdds() {
    try {
        const snap = await watchdogRead(_getDoc(doc(db, ...QUEUE_PATH)));
        if (!snap.exists()) return { items: [] };
        const d = snap.data() || {};
        return { items: Array.isArray(d.items) ? d.items : [] };
    } catch (e) {
        console.warn('[payroll] loadQueuedAdds failed:', e?.message);
        return { items: [], __error: true };
    }
}

export async function saveQueuedAdds(items, byName) {
    await watchdogWrite(_setDoc(doc(db, ...QUEUE_PATH), {
        items: trimConsumed(items),
        updatedAt: serverTimestamp(),
        updatedBy: byName || 'owner',
    }));
}

// ── pure helpers (unit-tested) ─────────────────────────────────────────
export const activeQueueItems = (items) => (items || []).filter((x) => !x.consumedIn);
export const consumedQueueItems = (items) => (items || []).filter((x) => !!x.consumedIn);

/** Drop consumed history beyond CONSUMED_KEEP (newest kept, by consumedAt). */
export function trimConsumed(items, keep = CONSUMED_KEEP) {
    const active = activeQueueItems(items);
    const consumed = consumedQueueItems(items)
        .slice()
        .sort((a, b) => String(b.consumedAt || '').localeCompare(String(a.consumedAt || '')))
        .slice(0, keep);
    return [...active, ...consumed];
}

/**
 * Copy every unconsumed item into run-adjustment rows and mark them
 * consumed. Returns { adjustments, items, count } — items is the NEW queue
 * array to persist; input is not mutated. `nextId(n)` mints run row ids.
 */
export function seedAdjustmentsFromQueue(items, period, nextId) {
    const adjustments = [];
    const out = (items || []).map((it) => {
        if (it.consumedIn) return it;
        adjustments.push({
            id: nextId(),
            loc: it.loc,
            key: it.key || '',
            name: it.name || '',
            type: it.type || 'bonus',
            amount: it.amount ?? '',
            hours: it.hours ?? '',
            perHour: it.perHour ?? '',
            rate: it.rate ?? '',
            note: it.note ?? '',
        });
        return { ...it, consumedIn: period, consumedAt: new Date().toISOString() };
    });
    return { adjustments, items: out, count: adjustments.length };
}

/** Put a consumed item back in the queue (run got scrapped / wrong period). */
export function requeueItem(items, id) {
    return (items || []).map((it) =>
        it.id === id ? { ...it, consumedIn: null, consumedAt: null } : it);
}

/**
 * Same rules the run enforces at generate time, applied early so a queued
 * reminder can't be un-payable months later. Returns null when valid,
 * else a short problem string.
 */
export function validateQueueItem(it) {
    if (!it.key) return 'no person picked';
    if (it.type === 'advance' && !String(it.note || '').trim()) return 'advance needs a note (check #)';
    const num = (v) => Number(v) > 0;
    if ((it.type === 'bonus' || it.type === 'advance' || it.type === 'other') && !num(it.amount)) return 'needs a $ amount';
    if ((it.type === 'vacation' || it.type === 'reg_hours' || it.type === 'ot_hours' || it.type === 'holiday') && !num(it.hours)) return 'needs hours';
    if (it.type === 'backpay' && (!num(it.hours) || !num(it.perHour))) return 'needs hours and $/hour';
    return null;
}
