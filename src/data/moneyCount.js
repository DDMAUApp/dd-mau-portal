// moneyCount.js — manager cash-drawer counter (Andrew 2026-06-25).
//
// A denomination counter: enter how many of each coin/bill, get a penny-exact
// total, save a timestamped record. Cash handling = ALL MATH IN INTEGER CENTS
// (never floats) so $0.01 + $0.10 never drifts. Each saved count is one
// `money_counts` doc with the per-denomination breakdown, total, who, where,
// and when. The catch-all Firestore rule already covers the new collection —
// no rules/index deploy (history uses a single-field orderBy, no composite).

import { collection, addDoc, onSnapshot, query, orderBy, limit, serverTimestamp } from 'firebase/firestore';
import { db } from '../firebase';

// US denominations, value in CENTS. Coins fill the LEFT column, bills the RIGHT
// (Andrew: "cents on the left and the bills on the right").
export const COIN_DENOMS = [
    { cents: 1,  label: '1¢' },
    { cents: 5,  label: '5¢' },
    { cents: 10, label: '10¢' },
    { cents: 25, label: '25¢' },
    { cents: 50, label: '50¢' },
];
export const BILL_DENOMS = [
    { cents: 100,   label: '$1' },
    { cents: 500,   label: '$5' },
    { cents: 1000,  label: '$10' },
    { cents: 2000,  label: '$20' },
    { cents: 5000,  label: '$50' },
    { cents: 10000, label: '$100' },
];
export const ALL_DENOMS = [...COIN_DENOMS, ...BILL_DENOMS];

// counts = { [cents]: howMany }. Returns the integer total in cents.
// Negative / fractional / NaN counts are floored to a safe non-negative int.
export function totalCents(counts) {
    let total = 0;
    for (const d of ALL_DENOMS) {
        const n = Math.floor(Number(counts?.[d.cents]) || 0);
        if (n > 0) total += d.cents * n;
    }
    return total;
}

// Cents → "$1,234.56" (penny-exact, no float formatting).
export function fmtMoney(cents) {
    const c = Math.round(Number(cents) || 0);
    const neg = c < 0 ? '-' : '';
    const a = Math.abs(c);
    return `${neg}$${Math.floor(a / 100).toLocaleString('en-US')}.${String(a % 100).padStart(2, '0')}`;
}

const COLL = 'money_counts';

// Persist a count. Sanitizes every denomination to a non-negative int and
// recomputes the total server-side-of-truth (we never trust a passed total).
export async function saveMoneyCount({ counts, staffName, staffId, location }) {
    const cleaned = {};
    for (const d of ALL_DENOMS) {
        const n = Math.floor(Number(counts?.[d.cents]) || 0);
        cleaned[d.cents] = n > 0 ? n : 0;
    }
    const total = totalCents(cleaned);
    const date = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
    const ref = await addDoc(collection(db, COLL), {
        counts: cleaned,
        totalCents: total,
        staffName: staffName || 'Unknown',
        staffId: staffId ?? null,
        location: location || 'webster',
        date,
        createdAt: serverTimestamp(),
        // Stable ordering key — serverTimestamp is null on the optimistic local
        // snapshot, so order + immediate display ride on this client ms instead.
        createdMs: Date.now(),
    });
    return ref.id;
}

// Newest-first history (single-field orderBy → no composite index). Caller
// filters by location client-side; volume is tiny so 60 is plenty.
export function subscribeMoneyCounts(cb, max = 60) {
    const q = query(collection(db, COLL), orderBy('createdMs', 'desc'), limit(max));
    return onSnapshot(
        q,
        (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
        (err) => { console.warn('money_counts subscribe failed:', err); cb([]); },
    );
}
