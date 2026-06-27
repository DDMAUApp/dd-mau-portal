// moneyCount.js — manager cash-drawer counter (Andrew 2026-06-25).
//
// A denomination counter: enter how many of each coin/bill, get a penny-exact
// total, save a timestamped record. Cash handling = ALL MATH IN INTEGER CENTS
// (never floats) so $0.01 + $0.10 never drifts. Each saved count is one
// `money_counts` doc with the per-denomination breakdown, total, who, where,
// and when. The catch-all Firestore rule already covers the new collection —
// no rules/index deploy (history uses a single-field orderBy, no composite).

import { collection, addDoc, onSnapshot, query, orderBy, limit, serverTimestamp, setDoc, doc, where, getDocs, getDoc, arrayUnion } from 'firebase/firestore';
import { db } from '../firebase';

// Central (America/Chicago) 'YYYY-MM-DD' for a Date (default now).
export function centralDate(d = new Date()) {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(d);
}

// "123.45" / "$1,234" / "5." → integer cents (penny-exact, no float). Caps at 2 decimals.
export function dollarsToCents(str) {
    const s = String(str ?? '').replace(/[^0-9.]/g, '');
    if (!s) return 0;
    const dot = s.indexOf('.');
    const dollars = parseInt((dot === -1 ? s : s.slice(0, dot)) || '0', 10) || 0;
    const frac = dot === -1 ? '' : s.slice(dot + 1).replace(/\./g, '');
    const cents = parseInt((frac + '00').slice(0, 2), 10) || 0;
    return dollars * 100 + cents;
}

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
    const date = centralDate();
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

// ── Cash tips — a SEPARATE daily total, saved on its own (not part of the
// drawer count). One total per (location, date): the doc id is deterministic,
// so re-entering a day OVERWRITES (corrects) it instead of double-counting. ──
const TIPS_COLL = 'cash_tips';

export async function saveCashTips({ date, amountCents, staffName, staffId, location }) {
    const loc = location || 'webster';
    const d = date || centralDate();
    const cents = Math.max(0, Math.round(Number(amountCents) || 0));
    await setDoc(doc(db, TIPS_COLL, `${loc}_${d}`), {
        date: d, amountCents: cents, location: loc,
        staffName: staffName || 'Unknown', staffId: staffId ?? null,
        updatedAt: serverTimestamp(), updatedMs: Date.now(),
    }, { merge: true });
    return `${loc}_${d}`;
}

// All cash-tip entries between two 'YYYY-MM-DD' dates (inclusive). Single-field
// date-range query → no composite index; caller filters location client-side.
export async function getCashTipsRange({ from, to }) {
    const q = query(collection(db, TIPS_COLL), where('date', '>=', from), where('date', '<=', to));
    const snap = await getDocs(q);
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

// Days in [from,to] (inclusive, 'YYYY-MM-DD') with NO tip entry — EXCLUDING
// **Sundays** (the restaurant is closed). `presentDates` = the dates that DO
// have an entry (Set or array). Returns the missing dates oldest-first. A
// calendar date is built at local noon so day-of-week is DST-safe and matches
// the plain Y-M-D (no timezone shift). 0 = Sunday.
export function missingTipDays(from, to, presentDates) {
    if (!from || !to || from > to) return [];
    const have = presentDates instanceof Set ? presentDates : new Set(presentDates || []);
    const [fy, fm, fd] = from.split('-').map(Number);
    const [ty, tm, td] = to.split('-').map(Number);
    if ([fy, fm, fd, ty, tm, td].some(Number.isNaN)) return [];
    const out = [];
    const cur = new Date(fy, fm - 1, fd, 12);
    const end = new Date(ty, tm - 1, td, 12);
    let guard = 0;
    while (cur <= end && guard++ < 1000) {
        const iso = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}-${String(cur.getDate()).padStart(2, '0')}`;
        if (cur.getDay() !== 0 && !have.has(iso)) out.push(iso);
        cur.setDate(cur.getDate() + 1);
    }
    return out;
}

// Correct a saved tip total and APPEND the change to an on-doc `edits` log
// ({oldCents,newCents,by,at}) so every correction is permanently visible — a
// mistake can be fixed without losing what it was before. Returns true if it
// changed, false if the value was the same (no-op, no log entry).
export async function editCashTips({ location, date, newAmountCents, by }) {
    const loc = location || 'webster';
    const ref = doc(db, TIPS_COLL, `${loc}_${date}`);
    const snap = await getDoc(ref);
    const oldCents = snap.exists() ? (Number(snap.data()?.amountCents) || 0) : 0;
    const cents = Math.max(0, Math.round(Number(newAmountCents) || 0));
    if (cents === oldCents) return false;
    await setDoc(ref, {
        amountCents: cents,
        updatedAt: serverTimestamp(), updatedMs: Date.now(),
        edits: arrayUnion({ oldCents, newCents: cents, by: by || 'Unknown', at: new Date().toISOString() }),
    }, { merge: true });
    return true;
}
