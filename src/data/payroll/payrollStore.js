// Firestore persistence for the in-app payroll feature. Three docs/collections,
// all new (covered by the catch-all rule — no rules deploy needed):
//   • config/payroll_meta    — { passwordHash, passwordSalt, nameAliases, ... }
//   • config/payroll_roster  — the shared cloud roster (replaces roster.json)
//   • payroll_runs/{autoId}   — one run summary per payroll, for history + the
//                               automatic period-over-period comparison
//
// The password gate is a salted SHA-256 (Web Crypto) — better than the existing
// plaintext config/secrets.insuranceAdminPin precedent. The hash being readable
// is acceptable: only owners (ids 40/41) reach the admin tab, both legitimately
// know the password, and the gate is an extra confirmation, not crypto-grade
// defense (Phase-2 Firebase Auth is the real lock).

import {
    doc, getDoc, setDoc, collection, addDoc, getDocs, query, where, orderBy, limit, serverTimestamp,
} from 'firebase/firestore';
import { db } from '../../firebase.js';
import { normalizeRoster, blankRoster } from './roster.js';

// Seeded from the standalone app's config.json. Toast-spelling → roster-spelling.
export const DEFAULT_NAME_ALIASES = {
    'Cruz-Hernandez, Edgar': 'Cruz, Edgar',
    'Turcios, Julio': 'Turcio, Julio',
    'Cruz, Marcos': 'Cruz, Marco',
    'McGruder, Cash': 'Magruder, Cash',
    'Njeri, Aaliyah': 'Njeri, Aailyah',
    'Curiel, Anacecilia': 'Curiel, Ana',
    'Campos, Chris': 'Campos, Christopher',
    'Mendieta, Ana': 'Medieta, Ana',
    'Miguel, Edith': 'Medieta , Edith',
};

// ── hashing ────────────────────────────────────────────────────────────────
function toHex(buf) {
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
// Web Crypto needs a secure context. All three production runtimes qualify (https
// PWA, iOS WKWebView, Android WebView); this guard just turns an opaque
// "Cannot read properties of undefined" rejection into a clear message if the
// app is ever opened over bare http.
function requireWebCrypto() {
    if (!globalThis.crypto || !globalThis.crypto.subtle) {
        throw new Error('The payroll password needs a secure (https) connection.');
    }
}
export async function hashPassword(password, salt) {
    requireWebCrypto();
    const enc = new TextEncoder().encode(`${salt}:${password}`);
    const digest = await crypto.subtle.digest('SHA-256', enc);
    return toHex(digest);
}
export function randomSalt() {
    requireWebCrypto();
    const a = new Uint8Array(16);
    crypto.getRandomValues(a);
    return toHex(a.buffer);
}

// ── password meta ────────────────────────────────────────────────────────────
// Returns the meta object, `null` if the doc genuinely doesn't exist (→ set a
// password), or `{ __error: true }` on a READ FAILURE. The gate must NOT treat a
// read failure as "no password set" — that would fail OPEN (offer to set a new
// password while offline). The caller distinguishes the two.
export async function loadPayrollMeta() {
    try {
        const snap = await getDoc(doc(db, 'config', 'payroll_meta'));
        return snap.exists() ? snap.data() : null;
    } catch (e) {
        console.warn('[payroll] loadPayrollMeta failed:', e?.message);
        return { __error: true };
    }
}

export async function setPayrollPassword(password, byName) {
    const salt = randomSalt();
    const passwordHash = await hashPassword(password, salt);
    await setDoc(
        doc(db, 'config', 'payroll_meta'),
        { passwordHash, passwordSalt: salt, updatedAt: serverTimestamp(), updatedBy: byName || '' },
        { merge: true },
    );
}

export async function verifyPayrollPassword(password, meta) {
    if (!meta || !meta.passwordHash || !meta.passwordSalt) return false;
    const h = await hashPassword(password, meta.passwordSalt);
    return h === meta.passwordHash;
}

export function nameAliasesFromMeta(meta) {
    const a = meta && meta.nameAliases;
    return (a && typeof a === 'object' && Object.keys(a).length) ? a : DEFAULT_NAME_ALIASES;
}

// ── roster ────────────────────────────────────────────────────────────────
export async function loadRoster() {
    try {
        const snap = await getDoc(doc(db, 'config', 'payroll_roster'));
        if (snap.exists()) return normalizeRoster(snap.data());
    } catch (e) {
        console.warn('[payroll] loadRoster failed:', e?.message);
    }
    return blankRoster();
}

function stripRuntime(data) {
    const out = JSON.parse(JSON.stringify(data));
    for (const loc of ['WG', 'MH']) {
        const people = (out[loc] && out[loc].people) || {};
        for (const k of Object.keys(people)) delete people[k].key; // in-memory echo only
    }
    return out;
}

export async function saveRoster(data) {
    await setDoc(doc(db, 'config', 'payroll_roster'), stripRuntime(data));
}

// ── run history + comparison ────────────────────────────────────────────────
export function buildRunSummary(period, results, ranBy) {
    const locations = {};
    for (const loc of Object.keys(results)) {
        const res = results[loc];
        const people = {};
        for (const sec of ['FOH', 'BOH']) {
            for (const r of res.sections[sec].rows) {
                people[r.key] = {
                    name: `${r.first} ${r.last}`, section: sec, rate: r.rate,
                    reg_hours: r.reg_hours, ot_hours: r.ot_hours, total_hours: r.total_hours,
                    tip_cents: r.tip_cents, comp_cents: r.comp_cents, direct_deposit: r.direct_deposit,
                };
            }
        }
        locations[loc] = {
            people,
            tips: res.tips,
            totals: res.totals,
            review: res.review.map((r) => ({ toast_name: r.toast_name, total_hours: r.total_hours })),
        };
    }
    return { period, ranBy: ranBy || '', locations };
}

export async function saveRun(period, results, ranBy) {
    const summary = buildRunSummary(period, results, ranBy);
    const payload = { ...summary, ranAt: serverTimestamp() };
    // Idempotent per period: regenerating the same period OVERWRITES its run doc
    // instead of piling up duplicates (which would corrupt the next period's
    // auto-comparison and fill the recent-runs window). where('period','==') is a
    // single-field equality — no composite index needed.
    try {
        const existing = await getDocs(query(collection(db, 'payroll_runs'), where('period', '==', period), limit(1)));
        if (!existing.empty) return setDoc(existing.docs[0].ref, payload);
    } catch (e) {
        console.warn('[payroll] saveRun dedupe check failed, appending:', e?.message);
    }
    return addDoc(collection(db, 'payroll_runs'), payload);
}

/** Most recent saved run whose period differs from `excludePeriod` (for the comparison workbook). */
export async function loadLatestRunSummary(excludePeriod) {
    try {
        const q = query(collection(db, 'payroll_runs'), orderBy('ranAt', 'desc'), limit(8));
        const snap = await getDocs(q);
        for (const docSnap of snap.docs) {
            const data = docSnap.data();
            if (data.period && data.period !== excludePeriod) return data;
        }
    } catch (e) {
        console.warn('[payroll] loadLatestRunSummary failed:', e?.message);
    }
    return null;
}
