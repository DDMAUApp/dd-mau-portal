// Per-location company info for onboarding employer-fill auto-fill.
// Andrew 2026-08-11: "the onboarding docs that ask for the company info
// like the bottom of the W-4s and I-9 — let me give you that info
// according to which location, so that can be auto filled."
//
// Storage: /config/onboarding_company =
//   {
//     webster:  { name, ein, address, signerTitle? },
//     maryland: { name, ein, address, signerTitle? },
//     updatedAt, updatedBy
//   }
// `address` is the full one-line mailing address ("11982 Dorsett Rd,
// Maryland Heights, MO 63043") because both the I-9 org-address box and
// the W-4 name+address box are single-line draws.
//
// The suggester below maps template FIELD LABELS → values. Labels come
// from the admin-placed template boxes (I-9) and the IRS AcroForm names
// (W-4: f1_12 name+address, f1_13 first date, f1_14 EIN) — patterns are
// written against the REAL labels in prod templates (probed 2026-08-11).
// Suggestions PRE-FILL the employer-fill form; the admin still reviews
// and can overwrite anything before finalizing, so a loose match can
// never silently sign a federal form wrong.

import { db } from '../firebase';
import { doc, getDoc as _fsGetDoc } from 'firebase/firestore';
import { watchdogRead } from './firestoreRevive';

const getDoc = (...a) => watchdogRead(_fsGetDoc(...a));

// Resolve the hire's location block. 'both' or unknown falls back to
// webster (the flagship) — the admin sees the values on screen and can
// correct before signing.
export function companyForLocation(data, location) {
    if (!data || typeof data !== 'object') return null;
    const key = location === 'maryland' ? 'maryland' : 'webster';
    const block = data[key] || data.webster || data.maryland || null;
    if (!block || typeof block !== 'object' || !block.name) return null;
    return block;
}

export async function loadCompanyInfoForHire(hire) {
    try {
        const snap = await getDoc(doc(db, 'config', 'onboarding_company'));
        if (!snap.exists()) return null;
        return companyForLocation(snap.data(), hire?.location);
    } catch (e) {
        console.warn('onboarding company info load failed:', e);
        return null;
    }
}

// Split a one-line mailing address into components for forms (like the
// MO W-4) that want street / city / state / ZIP in separate boxes.
// "8169 Big Bend Blvd, Webster Groves, MO 63119" →
//   { street, city, state, zip }. Tolerant: missing pieces come back ''.
export function splitAddress(address) {
    const parts = String(address || '').split(',').map(s => s.trim()).filter(Boolean);
    const out = { street: parts[0] || '', city: '', state: '', zip: '' };
    if (parts.length >= 3) {
        out.city = parts[1];
        const m = /^([A-Za-z]{2})\s+([\d-]{5,10})$/.exec(parts[2]) || [];
        out.state = m[1] || parts[2];
        out.zip = m[2] || '';
    } else if (parts.length === 2) {
        out.city = parts[1];
    }
    return out;
}

// 'yyyy-mm-dd' → 'mm/dd/yyyy'; anything else passes through untouched.
export function toUsDate(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '').trim());
    if (!m) return String(s || '');
    return `${m[2]}/${m[3]}/${m[1]}`;
}

// "Andrew Shih" → "Shih Andrew" (the I-9 signer box asks Last-First).
function lastFirst(fullName) {
    const parts = String(fullName || '').trim().split(/\s+/);
    if (parts.length < 2) return parts[0] || '';
    const last = parts[parts.length - 1];
    return `${last} ${parts.slice(0, -1).join(' ')}`;
}

// Pure label→value suggester. Returns { [f.id]: value } for employer-fill
// TEXT fields only (OnboardingEmployerFill keys its `values` state by
// f.id); matching runs against the human label, falling back to the id.
export function suggestEmployerValues(fields, { company, hire, adminName, todayStr }) {
    const out = {};
    if (!company) return out;
    const addr = String(company.address || '').trim();
    const name = String(company.name || '').trim();
    const ein = String(company.ein || '').trim();
    const title = String(company.signerTitle || 'Owner').trim();
    for (const f of (fields || [])) {
        if (f.filledBy !== 'employer') continue;
        if (f.type !== 'text') continue;   // never touch signatures/checkboxes
        const key = f.id;
        const l = String(f.label || f.id).toLowerCase();
        let v = null;
        const parts = splitAddress(addr);
        // ORDER MATTERS: the combined W-4 name+address box must win before
        // the name-only / address-only patterns get a look, and the MO W-4's
        // city/state/zip boxes must win before its plain address box.
        if (/f1_12|name and address/.test(l)) {
            v = addr ? `${name}, ${addr}` : name;
        } else if (/employer city/.test(l)) {
            v = parts.city;
        } else if (/employer state/.test(l)) {
            v = parts.state;
        } else if (/employer zip/.test(l)) {
            v = parts.zip;
        } else if (/employer.{0,2}s address/.test(l)) {
            v = parts.street;   // MO W-4 street box (city/state/zip separate)
        } else if (/(business|org\b|organization).{0,12}name|employer.{0,2}s name/.test(l)) {
            v = name;
        } else if (/(business|org\b|organization).{0,12}address/.test(l)) {
            v = addr;           // I-9 single-line org address
        } else if (/missouri tax/.test(l)) {
            v = String(company.moTaxId || '').trim();
        } else if (/f1_14|employer identification|federal employer i|(^|[^a-z])ein([^a-z]|$)/.test(l)) {
            v = ein;
        } else if (/f1_13|first date of employment|first ?day ?employed|date services/.test(l)) {
            v = toUsDate(hire?.hireDate);
        } else if (/todays? date/.test(l)) {
            v = todayStr || '';
        } else if (/title of employer|authorized representative/.test(l) && /name/.test(l)) {
            v = adminName ? `${lastFirst(adminName)}, ${title}` : '';
        }
        if (v) out[key] = v;
    }
    return out;
}
