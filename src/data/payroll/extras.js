// Structured pay-adds — faithful JS port of app/engine/extras.py.
//
// Each extra is saved per period. Types:
//   vacation : {hours}              → paid at base rate (VAC cols)
//   holiday  : {hours, rate?}       → paid at rate or base rate (HOL cols)
//   reg_hours: {hours}              → missed REG hours @ base rate (EXTRA PAY)
//   ot_hours : {hours}              → missed OT hours @ base rate ×1.5 (EXTRA PAY)
//   backpay  : {hours, per_hour}    → hours × $/hr (EXTRA PAY)
//   bonus    : {amount}             → flat $ (EXTRA PAY)
//   advance  : {amount}             → already-paid money DEDUCTED (negative)
//   other    : {amount}             → any other flat add, with a note
// All money is integer cents to keep totals penny-exact.

import { c as cents, fmtG, money2 } from './cents.js';

export const TYPES = ['vacation', 'holiday', 'reg_hours', 'ot_hours', 'backpay', 'bonus', 'advance', 'other'];

// Mirror Python's `!r` repr for the small set of error strings (cosmetic).
function repr(v) {
    if (v === null || v === undefined) return 'None';
    if (typeof v === 'string') return `'${v}'`;
    return String(v);
}

/**
 * Returns [cleanedExtra, error]. cleaned has computed signed `amount_cents` plus
 * hour fields where applicable. Mirrors extras.validate (which returns a tuple).
 */
export function validate(extra, masterByKey) {
    const t = extra.type;
    if (!TYPES.includes(t)) return [null, `unknown extra type ${repr(t)}`];
    const key = extra.key || '';
    const emp = masterByKey && Object.prototype.hasOwnProperty.call(masterByKey, key)
        ? masterByKey[key] : undefined;
    if (emp === undefined || emp === null) {
        return [null, `extra for unknown person (key=${repr(key)}, name=${repr(extra.name)})`];
    }

    const note = String(extra.note === null || extra.note === undefined ? '' : extra.note).trim();
    const out = { type: t, key, location: extra.location, name: `${emp.first} ${emp.last}`, note };

    // float(extra.get(field)): None/''/non-numeric → "must be a number".
    const posNum = (field, what) => {
        const raw = extra[field];
        if (raw === null || raw === undefined || raw === '') return [null, `${out.name}: ${what} must be a number`];
        const v = Number(raw);
        if (Number.isNaN(v)) return [null, `${out.name}: ${what} must be a number`];
        if (v <= 0) return [null, `${out.name}: ${what} must be more than 0`];
        return [v, null];
    };

    if (t === 'vacation') {
        const [hours, err] = posNum('hours', 'vacation hours');
        if (err) return [null, err];
        out.hours = hours;
        out.rate = emp.rate;
        out.amount_cents = cents(hours * emp.rate);
    } else if (t === 'holiday') {
        const [hours, err] = posNum('hours', 'holiday hours');
        if (err) return [null, err];
        let rate = extra.rate;
        if (rate === null || rate === undefined || rate === '') {
            rate = emp.rate;
        } else {
            const rv = Number(rate);
            if (Number.isNaN(rv)) return [null, `${out.name}: holiday rate must be a number`];
            rate = rv;
        }
        out.hours = hours;
        out.rate = rate;
        out.amount_cents = cents(hours * rate);
    } else if (t === 'reg_hours') {
        const [hours, err] = posNum('hours', 'additional regular hours');
        if (err) return [null, err];
        out.hours = hours;
        out.rate = emp.rate;
        out.amount_cents = cents(hours * emp.rate);
        if (!note) out.note = `added ${fmtG(hours)} reg hrs @ $${fmtG(emp.rate)}/hr`;
    } else if (t === 'ot_hours') {
        const [hours, err] = posNum('hours', 'additional OT hours');
        if (err) return [null, err];
        out.hours = hours;
        out.rate = emp.rate;
        out.amount_cents = cents(hours * emp.rate * 1.5);
        if (!note) out.note = `added ${fmtG(hours)} OT hrs @ $${fmtG(emp.rate)}x1.5`;
    } else if (t === 'backpay') {
        const [hours, errH] = posNum('hours', 'back pay hours');
        if (errH) return [null, errH];
        const [perHour, errP] = posNum('per_hour', 'back pay $/hour');
        if (errP) return [null, errP];
        out.hours = hours;
        out.per_hour = perHour;
        out.amount_cents = cents(hours * perHour);
        if (!note) out.note = `back pay ${fmtG(hours)}h x $${fmtG(perHour)}/hr`;
    } else if (t === 'bonus') {
        const [amount, err] = posNum('amount', 'bonus amount');
        if (err) return [null, err];
        out.amount_cents = cents(amount);
    } else if (t === 'advance') {
        const [amount, err] = posNum('amount', 'advance amount');
        if (err) return [null, err];
        out.amount_cents = -cents(amount); // deduction
        if (!note) {
            return [null, `${out.name}: an advance needs a note (when/why the money was already paid, check #)`];
        }
    } else if (t === 'other') {
        const [amount, err] = posNum('amount', 'other pay amount');
        if (err) return [null, err];
        out.amount_cents = cents(amount);
    }
    return [out, null];
}

/** One-line human description used in cell comments + the EXTRAS sheet. Mirrors extras.describe. */
export function describe(extra) {
    const t = extra.type;
    const amt = Math.abs(extra.amount_cents) / 100.0;
    if (t === 'vacation') return `vacation ${fmtG(extra.hours)}h @ $${fmtG(extra.rate)} = $${money2(amt)}`;
    if (t === 'holiday') return `holiday ${fmtG(extra.hours)}h @ $${fmtG(extra.rate)} = $${money2(amt)}`;
    if (t === 'reg_hours') return `added ${fmtG(extra.hours)} reg hrs @ $${fmtG(extra.rate)} = +$${money2(amt)}`;
    if (t === 'ot_hours') return `added ${fmtG(extra.hours)} OT hrs @ $${fmtG(extra.rate)}x1.5 = +$${money2(amt)}`;
    if (t === 'backpay') return `back pay ${fmtG(extra.hours)}h x $${fmtG(extra.per_hour)}/hr = +$${money2(amt)}`;
    if (t === 'bonus') return `bonus +$${money2(amt)}`;
    if (t === 'advance') return `advance already paid, deducted -$${money2(amt)}`;
    if (t === 'other') return `other pay +$${money2(amt)}`;
    return t;
}
