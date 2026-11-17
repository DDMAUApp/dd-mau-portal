// cateringDraft.js — crash-safe draft for the catering order form.
//
// 2026-11-17 (Andrew: "yesterday yulissa tried to put in a catering order
// but she was having trouble"): the Maryland iPad's database connection
// wedged three times while she was on the Catering tab / saving; each time
// the app's auto-recovery reloaded the page and the order — held only in
// React state — was gone. Now the form autosaves here (per person: the
// store iPad is shared) and comes back after any reload. 24 h lifetime.
//
// `newOrderId` is the Firestore id the order WILL be saved under, chosen up
// front: a retry after a stuck save (or after a reload) rewrites the same
// document instead of creating a duplicate order + duplicate manager push.

const PREFIX = 'ddmau:cateringDraft:';
export const CATERING_DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

const keyFor = (staffName) => PREFIX + String(staffName || 'unknown').trim().toLowerCase();

// Worth keeping? Something typed beyond the defaults.
export function draftHasContent(d) {
    if (!d) return false;
    const c = d.customer || {};
    return (Array.isArray(d.cart) && d.cart.length > 0)
        || ['name', 'phone', 'email', 'date', 'time', 'guests', 'address'].some(k => String(c[k] || '').trim())
        || !!String(d.specialNotes || '').trim();
}

export function loadCateringDraft(staffName, now = Date.now()) {
    try {
        const raw = localStorage.getItem(keyFor(staffName));
        if (!raw) return null;
        const d = JSON.parse(raw);
        if (!d || typeof d !== 'object' || !(now - Number(d.savedAt) < CATERING_DRAFT_TTL_MS) || !draftHasContent(d)) {
            localStorage.removeItem(keyFor(staffName));
            return null;
        }
        return d;
    } catch { return null; }
}

export function saveCateringDraft(staffName, draft, now = Date.now()) {
    try {
        if (!draftHasContent(draft)) { localStorage.removeItem(keyFor(staffName)); return; }
        localStorage.setItem(keyFor(staffName), JSON.stringify({ ...draft, savedAt: now }));
    } catch { /* storage full/blocked — the draft is a safety net, never a blocker */ }
}

export function clearCateringDraft(staffName) {
    try { localStorage.removeItem(keyFor(staffName)); } catch { /* ignore */ }
}
