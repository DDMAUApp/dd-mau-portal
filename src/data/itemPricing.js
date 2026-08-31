// itemPricing.js — trusted inventory item pricing engine.
//
// Inventory pricing redesign, Phase 1 (Andrew 2026-06-14). Replaces the
// unreliable scraped Sysco/US Foods catalog pricing with a per-item,
// source-aware, trust-ranked model.
//
// THIS MODULE IS PURE LOGIC + INERT FIRESTORE HELPERS. Nothing imports it
// yet — wiring into Operations.jsx / the cart happens in later slices, so
// landing this changes NOTHING in the live app. The pure functions
// (parsePackToUnits / perUnitPrice / resolveTrustedPrice / cheapestVendor /
// lastOrdered / isStale) are unit-tested in itemPricing.test.js.
//
// New Firestore collection (additive — old code never reads it, so rollback
// is just "stop reading it"):
//   item_prices_{location}/{itemId} = {
//     itemId, location,
//     manual:  { price, unit, pack, perUnit, vendor, effectiveDate, by, at, note } | null,
//     byVendor: {
//        [vendor]: { price, pack, unit, perUnit, source, lastPurchased, by, at }
//     },
//     history: [ { oldPrice, newPrice, source, vendor, by, at, reason } ]  (capped)
//   }

import {
    collection, doc, onSnapshot, serverTimestamp, runTransaction,
} from 'firebase/firestore';
import { db } from '../firebase';
import { normalizeVendor } from './inventory';
// Wedged-connection watchdog (2026-08-31, Andrew: receipt save "stuck on
// saving"): scanning a receipt backgrounds the app into the camera, iOS
// kills the Firestore socket, and the SAVE is the first write after resume
// — on the wedged transport a raw runTransaction hangs FOREVER with no
// pill and no recovery. Same class (and same fix) as Money Count's tip
// save: every write in this module runs under watchdogWrite (pill + 8s
// network revive + idle-guarded reload escalation). The scan draft
// (ReceiptScanModal) survives any escalation reload via its Resume banner.
import { watchdogWrite } from './firestoreRevive';

// ── Price source taxonomy + trust ranking ───────────────────────────────
// Lower rank = MORE trusted. This is the priority order Andrew approved:
// approved manual > latest verified purchase (receipt/invoice) > approved
// vendor quote > rolling average > estimated > legacy scraped (last resort).
export const PRICE_SOURCE = {
    MANUAL: 'manual',
    INVOICE: 'invoice',          // extracted from a receipt/invoice = real purchase
    VENDOR_QUOTE: 'vendor_quote',
    CSV: 'csv',                  // bulk order-guide import
    AVERAGE: 'average',
    ESTIMATED: 'estimated',
    LEGACY_SCRAPED: 'legacy_scraped',
};

export const PRICE_SOURCE_RANK = {
    manual: 1,
    invoice: 2,
    vendor_quote: 3,
    csv: 4,
    average: 5,
    estimated: 6,
    legacy_scraped: 7,
};

export const PRICE_SOURCE_LABEL = {
    manual:         { en: 'Manual',        es: 'Manual' },
    invoice:        { en: 'Receipt',       es: 'Recibo' },
    vendor_quote:   { en: 'Vendor quote',  es: 'Cotización' },
    csv:            { en: 'Import',        es: 'Importado' },
    average:        { en: 'Avg purchase',  es: 'Promedio' },
    estimated:      { en: 'Estimated',     es: 'Estimado' },
    legacy_scraped: { en: 'Old scraper ⚠', es: 'Robot viejo ⚠' },
};

// A trusted price older than this many days is flagged "stale" in the UI.
export const STALE_DAYS = 45;

// ── Pack → base-unit parsing ─────────────────────────────────────────────
// Ported VERBATIM from Operations.jsx (parsePackToUnits) so the per-unit
// math the new engine produces matches what the app already computes — no
// silent drift in "cheapest vendor" between old and new code paths.
// Returns { total, unit } in a canonical base unit per dimension
// (lb / gal / ct / lt / rl / ft) or null if the pack can't be parsed.
export function parsePackToUnits(pack) {
    if (!pack) return null;
    const p = String(pack).trim().toUpperCase();
    let m;
    // Direct weight: '50lb', '30 LB'
    m = p.match(/^(\d+\.?\d*)\s*(LB|LBS?)$/); if (m) return { total: parseFloat(m[1]), unit: 'lb' };
    if (p === 'LB') return { total: 1, unit: 'lb' };
    if (p === 'EA') return { total: 1, unit: 'ea' };
    // Multiplied lb packs: '4/19 LBA', '3/17#AVG', '5/10#UP', '2/5 LB'
    m = p.match(/^(\d+)[/xX](\d+\.?\d*)\s*(LB|LBA|LBS?|#AVG|#UP|#)/); if (m) return { total: parseFloat(m[1]) * parseFloat(m[2]), unit: 'lb' };
    // '5x5lb', '6/5lb'
    m = p.match(/^(\d+)[/xX](\d+\.?\d*)\s*LBS?$/); if (m) return { total: parseFloat(m[1]) * parseFloat(m[2]), unit: 'lb' };
    // Gallons: '4/1 GA', '5 GA', '9/0.5GAL', '5gal'
    m = p.match(/^(\d+)[/xX](\d+\.?\d*)\s*GA[L]?$/); if (m) return { total: parseFloat(m[1]) * parseFloat(m[2]), unit: 'gal' };
    m = p.match(/^(\d+\.?\d*)\s*GA[L]?$/); if (m) return { total: parseFloat(m[1]), unit: 'gal' };
    // Liters: '5 LT'
    m = p.match(/^(\d+\.?\d*)\s*LT$/); if (m) return { total: parseFloat(m[1]), unit: 'lt' };
    // Ounce packs to lb: '120/1.5 OZ', '48/3 OZ'
    m = p.match(/^(\d+)[/xX](\d+\.?\d*)\s*OZ$/); if (m) return { total: parseFloat(m[1]) * parseFloat(m[2]) / 16, unit: 'lb' };
    // Count packs: '12/500 CT', '200 EA', '12/100 EA'
    m = p.match(/^(\d+)[/xX](\d+)\s*(CT|EA)$/); if (m) return { total: parseFloat(m[1]) * parseFloat(m[2]), unit: 'ct' };
    m = p.match(/^(\d+)\s*(CT|EA)$/); if (m) return { total: parseFloat(m[1]), unit: 'ct' };
    // Simple count: '1000', '400pc', '500pk', '2500p'
    m = p.match(/^(\d+)\s*(PC|PK|P|SET)?$/); if (m) return { total: parseFloat(m[1]), unit: 'ct' };
    // Multiplied without unit: '10/25', '4x125'
    m = p.match(/^(\d+)[/xX](\d+)$/); if (m) return { total: parseFloat(m[1]) * parseFloat(m[2]), unit: 'ct' };
    // '80/550CT', '1/500CT'
    m = p.match(/^(\d+)[/xX](\d+)\s*CT$/); if (m) return { total: parseFloat(m[1]) * parseFloat(m[2]), unit: 'ct' };
    // Quarts: '12/1 QT'
    m = p.match(/^(\d+)[/xX](\d+\.?\d*)\s*QT$/); if (m) return { total: parseFloat(m[1]) * parseFloat(m[2]) * 0.25, unit: 'gal' };
    // Rolls: '6 RL'
    m = p.match(/^(\d+)\s*RL$/); if (m) return { total: parseFloat(m[1]), unit: 'rl' };
    // Feet: '3/1150FT'
    m = p.match(/^(\d+)[/xX](\d+)\s*FT$/); if (m) return { total: parseFloat(m[1]) * parseFloat(m[2]), unit: 'ft' };
    // '1/40 LB'
    m = p.match(/^(\d+)[/xX](\d+\.?\d*)\s*LB$/); if (m) return { total: parseFloat(m[1]) * parseFloat(m[2]), unit: 'lb' };
    return null;
}

// Per-unit price for a (price, pack) pair. Returns { perUnit, unit, packTotal }
// or null when price is missing/invalid or the pack can't be parsed (caller
// then knows to flag "missing pack/unit info" and fall back to raw price).
export function perUnitPrice(price, pack) {
    if (price == null || typeof price !== 'number' || !isFinite(price) || price < 0) return null;
    const parsed = parsePackToUnits(pack);
    if (!parsed || !(parsed.total > 0)) return null;
    return { perUnit: price / parsed.total, unit: parsed.unit, packTotal: parsed.total };
}

// ── Canonical vendor key (2026-08-31, Andrew: "always use where we usually
// order from") ──────────────────────────────────────────────────────────
// Receipts print the same vendor a dozen ways ("ST. LOUIS WHOLESALE FOODS,
// INC." / "ST. Louis Wholesale Foods, Inc." / "STL Wholesale") and the AI
// preserves whatever it read — live data had ONE vendor split across two
// byVendor keys on 30 items. Every byVendor write now lands under ONE
// canonical key: the normalizeVendor() bucket when the vendor is one of
// the 8 known ones; unknown vendors (e.g. "The Authentic French Bakery")
// keep their identity, title-cased so case variants merge too.
export function canonicalVendorKey(raw) {
    const t = (raw == null ? '' : String(raw)).replace(/\s+/g, ' ').trim();
    if (!t) return 'Other';
    const canon = normalizeVendor(t);
    if (canon && canon !== 'Other') return canon;
    return t.toLowerCase().replace(/(^|[\s(\-\/&.,'"])([a-z])/g, (m, p, c) => p + c.toUpperCase());
}

// Do two vendor strings refer to the same vendor? Canonical-key equality.
export function sameVendor(a, b) {
    return canonicalVendorKey(a) === canonicalVendorKey(b);
}

// ── Internal: coerce a timestamp-ish value to millis ─────────────────────
function toMillis(v) {
    if (v == null) return 0;
    if (typeof v === 'number') return v;
    if (typeof v === 'string') { const t = Date.parse(v); return isNaN(t) ? 0 : t; }
    if (typeof v?.toMillis === 'function') return v.toMillis();        // Firestore Timestamp
    if (typeof v?.seconds === 'number') return v.seconds * 1000;       // plain {seconds,nanos}
    if (v instanceof Date) return v.getTime();
    return 0;
}

// Is a trusted price stale? `nowMs` is injectable for testability.
export function isStale(updatedAt, days = STALE_DAYS, nowMs = Date.now()) {
    const ms = toMillis(updatedAt);
    if (!ms) return false; // unknown date — don't cry wolf
    return (nowMs - ms) > days * 86400000;
}

// ── Build the candidate list from an item_prices doc ─────────────────────
// Each candidate: { source, vendor, price, pack, unit, perUnit, at }
function priceCandidates(priceDoc) {
    const out = [];
    if (!priceDoc) return out;
    const m = priceDoc.manual;
    if (m && m.price != null) {
        const pu = m.perUnit != null ? { perUnit: m.perUnit, unit: m.unit } : perUnitPrice(m.price, m.pack);
        out.push({
            source: PRICE_SOURCE.MANUAL, vendor: m.vendor || null, price: m.price,
            pack: m.pack || null, unit: pu?.unit || m.unit || null, perUnit: pu?.perUnit ?? null,
            at: m.effectiveDate || m.at || null,
        });
    }
    const bv = priceDoc.byVendor || {};
    for (const [vendor, e] of Object.entries(bv)) {
        if (!e || e.price == null) continue;
        const pu = e.perUnit != null ? { perUnit: e.perUnit, unit: e.unit } : perUnitPrice(e.price, e.pack);
        out.push({
            source: e.source || PRICE_SOURCE.LEGACY_SCRAPED, vendor,
            price: e.price, pack: e.pack || null,
            unit: pu?.unit || e.unit || null, perUnit: pu?.perUnit ?? null,
            at: e.lastPurchased || e.at || null,
        });
    }
    return out;
}

// ── resolveTrustedPrice ──────────────────────────────────────────────────
// The single "what is this item's price" number, honoring the trust order.
// Returns { price, perUnit, unit, vendor, source, at, stale } or null.
// Legacy scraped prices only win when nothing better exists, and they're
// always returned with source='legacy_scraped' so the UI labels them.
// `preferredVendor` (2026-08-31, Andrew: "always use where we usually order
// from") pins the shown price to the item's assigned vendor: within the same
// trust rank, the usual vendor's entry beats a NEWER entry from a one-off
// vendor — a single Costco run no longer flips the item's price until the
// next usual-vendor purchase. Other vendors still surface when the usual
// vendor has no price at all (`fromUsualVendor: false` so the UI labels it).
export function resolveTrustedPrice(priceDoc, { nowMs = Date.now(), preferredVendor = null } = {}) {
    const candidates = priceCandidates(priceDoc);
    if (!candidates.length) return null;
    const prefKey = preferredVendor ? canonicalVendorKey(preferredVendor) : null;
    const pinning = !!(prefKey && prefKey !== 'Other');
    const usual = (c) => (pinning && c.vendor && canonicalVendorKey(c.vendor) === prefKey) ? 1 : 0;
    candidates.sort((a, b) => {
        const ra = PRICE_SOURCE_RANK[a.source] ?? 99;
        const rb = PRICE_SOURCE_RANK[b.source] ?? 99;
        if (ra !== rb) return ra - rb;              // more trusted source first
        const ua = usual(a), ub = usual(b);
        if (ua !== ub) return ub - ua;              // then the USUAL vendor
        return toMillis(b.at) - toMillis(a.at);     // then most recent
    });
    const best = candidates[0];
    return {
        price: best.price, perUnit: best.perUnit, unit: best.unit,
        vendor: best.vendor, source: best.source, at: best.at || null,
        stale: isStale(best.at, STALE_DAYS, nowMs),
        // false ONLY when pinning was requested and an off-vendor INVOICE
        // price won (usual vendor has no usable entry) — the UI shows whose
        // price it is then. A manual price is a deliberate admin choice, so
        // it's never labeled as foreign regardless of its vendor field.
        fromUsualVendor: (pinning && best.source === PRICE_SOURCE.INVOICE) ? usual(best) === 1 : true,
    };
}

// ── cheapestVendor ───────────────────────────────────────────────────────
// "Where should we order this from?" — lowest PER-UNIT price across vendors,
// apples-to-apples. Only compares within a single base unit; picks the unit
// group with the most priced vendors (ties → bigger group / better source).
// Falls back to lowest RAW price when no packs parse. Returns
// { vendor, price, perUnit, unit, source, comparable } or null.
export function cheapestVendor(priceDoc) {
    // Must have a VENDOR to order from — a vendor-less manual price is a
    // valid "trusted price" but not an order-routing answer, so exclude it.
    const cands = priceCandidates(priceDoc).filter(c => c.price != null && c.vendor);
    if (!cands.length) return null;

    // Group the per-unit-comparable candidates by base unit.
    const byUnit = new Map();
    for (const c of cands) {
        if (c.perUnit == null || !c.unit) continue;
        if (!byUnit.has(c.unit)) byUnit.set(c.unit, []);
        byUnit.get(c.unit).push(c);
    }
    if (byUnit.size) {
        // Choose the unit group with the most vendors (most meaningful
        // comparison). Fully deterministic tiebreaks: more vendors → most-
        // trusted source in the group → unit name asc (so the result never
        // depends on Map insertion order).
        let bestGroup = null, bestUnit = null, bestRank = Infinity;
        for (const [unit, group] of byUnit) {
            const rank = Math.min(...group.map(g => PRICE_SOURCE_RANK[g.source] ?? 99));
            const better = !bestGroup
                || group.length > bestGroup.length
                || (group.length === bestGroup.length && rank < bestRank)
                || (group.length === bestGroup.length && rank === bestRank && unit < bestUnit);
            if (better) { bestGroup = group; bestUnit = unit; bestRank = rank; }
        }
        const winner = bestGroup.slice().sort(
            (a, b) => a.perUnit - b.perUnit || String(a.vendor).localeCompare(String(b.vendor))
        )[0];
        return { ...winner, comparable: true };
    }
    // No parseable packs anywhere → fall back to lowest raw price (stable).
    const winner = cands.slice().sort(
        (a, b) => a.price - b.price || String(a.vendor).localeCompare(String(b.vendor))
    )[0];
    return { ...winner, comparable: false };
}

// ── lastOrdered ──────────────────────────────────────────────────────────
// Most recent ACTUAL purchase (receipt/invoice) for the cart's
// "last ordered $Y on [date]" line. Returns { vendor, price, at } or null.
export function lastOrdered(priceDoc) {
    const bv = priceDoc?.byVendor || {};
    let best = null;
    for (const [vendor, e] of Object.entries(bv)) {
        if (!e || e.price == null) continue;
        if (e.source !== PRICE_SOURCE.INVOICE) continue;
        const at = e.lastPurchased || e.at || null;
        if (!best || toMillis(at) > toMillis(best.at)) best = { vendor, price: e.price, at };
    }
    return best;
}

// Does an item lack the pack/unit info needed for honest per-unit pricing?
export function missingPackUnit(item) {
    return !item || !item.pack || parsePackToUnits(item.pack) == null;
}

// ─────────────────────────────────────────────────────────────────────────
// Firestore I/O — INERT until a later slice wires the UI to call these.
// Admin-only writes are enforced at the call site + Firestore rules (added
// in a later slice); these helpers just shape the data.
// ─────────────────────────────────────────────────────────────────────────

export function itemPricesCollPath(location) {
    return `item_prices_${location}`;
}

// Live subscription to all item_prices docs for a location → { [itemId]: doc }.
export function subscribeItemPrices(location, cb) {
    const coll = collection(db, itemPricesCollPath(location));
    return onSnapshot(coll, (snap) => {
        const map = {};
        snap.forEach((d) => { map[d.id] = { itemId: d.id, ...d.data() }; });
        cb(map);
    }, (err) => { console.error('[itemPricing] subscribe error', err); cb({}); });
}

// Set/replace the MANUAL trusted price for an item (admin action).
// Appends a capped history entry. Merges so byVendor is preserved.
export async function setManualPrice(location, itemId, fields, byName) {
    const ref = doc(db, itemPricesCollPath(location), String(itemId));
    const pu = perUnitPrice(fields.price, fields.pack);
    // Transaction so a concurrent write to the same item (e.g. a receipt
    // import landing at the same moment) can't drop history entries via a
    // stale read-modify-write of the `history` array.
    await watchdogWrite(runTransaction(db, async (tx) => {
        const snap = await tx.get(ref);
        const prev = snap.exists() ? snap.data() : {};
        const prevManual = prev.manual || null;
        const manual = {
            price: fields.price ?? null,
            unit: pu?.unit || fields.unit || null,
            pack: fields.pack || null,
            perUnit: pu?.perUnit ?? null,
            vendor: fields.vendor ? normalizeVendor(fields.vendor) : null,
            effectiveDate: fields.effectiveDate || new Date().toISOString().slice(0, 10),
            note: fields.note || null,
            by: byName || null,
            at: serverTimestamp(),
        };
        const historyEntry = {
            oldPrice: prevManual?.price ?? null,
            newPrice: manual.price,
            source: PRICE_SOURCE.MANUAL,
            vendor: manual.vendor,
            by: byName || null,
            at: new Date().toISOString(),
            reason: fields.reason || 'manual edit',
        };
        const history = [...(prev.history || []), historyEntry].slice(-50); // cap growth
        tx.set(ref, { itemId: String(itemId), location, manual, history }, { merge: true });
    }));
}

// Clear a manual price (2026-08-31): a set manual price outranks every
// receipt FOREVER, and until now there was no way to remove it — the #1
// reason scanned prices "didn't update." Clearing lets the receipt-based
// price show again. History records the clear (newPrice null rows are
// hidden by the history view's filter — this is an audit row, not a price).
export async function clearManualPrice(location, itemId, byName) {
    const ref = doc(db, itemPricesCollPath(location), String(itemId));
    await watchdogWrite(runTransaction(db, async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists()) return;
        const prev = snap.data();
        if (!prev.manual || prev.manual.price == null) return;   // nothing to clear
        const historyEntry = {
            oldPrice: prev.manual.price, newPrice: null,
            source: PRICE_SOURCE.MANUAL, vendor: prev.manual.vendor || null,
            by: byName || null, at: new Date().toISOString(),
            reason: 'manual price cleared',
        };
        const history = [...(prev.history || []), historyEntry].slice(-50);
        tx.set(ref, { manual: null, history }, { merge: true });
    }));
}

// ── One-time vendor-key merge (2026-08-31 migration helper) ──────────────
// Pure: collapses a doc's byVendor keys onto canonical keys (newest entry
// per canonical group wins — entries are last-state snapshots) and rewrites
// history[].vendor to the canonical name. Returns null when nothing changes.
export function mergeVendorKeys(docData) {
    const bv = docData?.byVendor;
    if (!bv || typeof bv !== 'object') return null;
    const groups = new Map();
    let changed = false;
    for (const [k, e] of Object.entries(bv)) {
        const ck = canonicalVendorKey(k);
        if (ck !== k) changed = true;
        const at = toMillis(e?.lastPurchased || e?.at);
        const cur = groups.get(ck);
        if (!cur || at > cur.at) groups.set(ck, { entry: e, at });
        else changed = true;   // dropped an older duplicate — a change too
    }
    const history = (docData.history || []).map((h) => {
        if (!h || !h.vendor) return h;
        const ck = canonicalVendorKey(h.vendor);
        if (ck === h.vendor) return h;
        changed = true;
        return { ...h, vendor: ck };
    });
    if (!changed) return null;
    const byVendor = {};
    for (const [ck, g] of groups.entries()) byVendor[ck] = g.entry;
    return { byVendor, history };
}

// Record an actual purchase (from a confirmed receipt match) → updates the
// vendor's entry as source='invoice' with lastPurchased + lastQty, + history.
// `qty` = how much was ordered (receipt line quantity) — drives the cart's
// "last ordered / average ordered" reorder hint via orderQtyStats.
export async function recordPurchase(location, itemId, { vendor, price, pack, unit, qty, by, purchasedDate, reason, code, brand }) {
    const ref = doc(db, itemPricesCollPath(location), String(itemId));
    const pu = perUnitPrice(price, pack);
    const qn = (qty != null && isFinite(Number(qty)) && Number(qty) >= 0) ? Number(qty) : null;
    // Canonical byVendor key (2026-08-31 — supersedes the Phase-2 "preserve
    // the raw receipt string" choice): every spelling of the same vendor
    // lands under one key, so the usual-vendor pin + last-price continuity
    // work. The RAW receipt vendor still lives on the scan record.
    const vKey = canonicalVendorKey(vendor);
    // Transaction — same history-loss guard as setManualPrice.
    await watchdogWrite(runTransaction(db, async (tx) => {
        const snap = await tx.get(ref);
        const prev = snap.exists() ? snap.data() : {};
        const prevEntry = (prev.byVendor || {})[vKey] || null;
        const entry = {
            price: price ?? null, pack: pack || null,
            unit: pu?.unit || unit || null, perUnit: pu?.perUnit ?? null,
            source: PRICE_SOURCE.INVOICE,
            lastPurchased: purchasedDate || new Date().toISOString().slice(0, 10),
            lastQty: qn,
            // Vendor SKU / item # + brand from the invoice — kept on the latest
            // per-vendor entry so the same product is recognizable next time.
            code: code || prevEntry?.code || null, brand: brand || prevEntry?.brand || null,
            by: by || null, at: serverTimestamp(),
        };
        const historyEntry = {
            oldPrice: prevEntry?.price ?? null, newPrice: entry.price,
            // Andrew 2026-06-25 — store the INVOICE date + per-unit on each
            // purchase row so the item price-history view can place each price
            // at the date it was actually bought (not when it was scanned).
            purchasedDate: purchasedDate || null,
            pack: pack || null, unit: entry.unit, perUnit: entry.perUnit,
            code: code || null, brand: brand || null,
            source: PRICE_SOURCE.INVOICE, vendor: vKey, qty: qn, by: by || null,
            at: new Date().toISOString(), reason: reason || 'receipt import',
        };
        const history = [...(prev.history || []), historyEntry].slice(-50);
        // Dedicated purchase-quantity log — separate from the mixed price
        // `history` (which manual edits also append to and which is capped at
        // 50), so the cart's "average ordered" reflects actual purchases, not
        // a window polluted by price edits. Only real order quantities (>0).
        const qtyHistory = [...(prev.qtyHistory || [])];
        if (qn != null && qn > 0) qtyHistory.push({ qty: qn, at: new Date().toISOString() });
        tx.set(ref, {
            itemId: String(itemId), location,
            byVendor: { [vKey]: entry },
            history,
            qtyHistory: qtyHistory.slice(-60),
        }, { merge: true });
    }));
}

// last (most recent by ts; ties resolve to the later-appended sample) + mean
// over a list of { qty, at } samples. null if empty.
function _qtyStatsFrom(samples) {
    if (!samples.length) return null;
    let last = samples[0];
    for (const s of samples) if (toMillis(s.at) >= toMillis(last.at)) last = s;
    const avg = samples.reduce((a, s) => a + s.qty, 0) / samples.length;
    return { lastQty: last.qty, lastQtyAt: last.at, avgQty: avg, count: samples.length };
}

// ── orderQtyStats ────────────────────────────────────────────────────────
// "How much do we usually order?" for the cart's reorder hint →
// { lastQty, lastQtyAt, avgQty, count } or null. Sources, in order:
//   1) qtyHistory — the dedicated purchase-quantity log (preferred; not
//      polluted by manual price edits, capped at the last 60 purchases);
//   2) INVOICE qty carried on the mixed price `history` (docs written before
//      qtyHistory existed);
//   3) a byVendor lastQty (oldest fallback).
export function orderQtyStats(priceDoc) {
    const pickQty = (h) => (h && isFinite(Number(h.qty)) && Number(h.qty) > 0);
    const map = (h) => ({ qty: Number(h.qty), at: h.at || null });

    const qh = (Array.isArray(priceDoc?.qtyHistory) ? priceDoc.qtyHistory : []).filter(pickQty).map(map);
    const fromQh = _qtyStatsFrom(qh);
    if (fromQh) return fromQh;

    const hist = (Array.isArray(priceDoc?.history) ? priceDoc.history : [])
        .filter((h) => h && h.source === PRICE_SOURCE.INVOICE && pickQty(h)).map(map);
    const fromHist = _qtyStatsFrom(hist);
    if (fromHist) return fromHist;

    const bv = priceDoc?.byVendor || {};
    let best = null;
    for (const e of Object.values(bv)) {
        if (!e || e.lastQty == null || !isFinite(Number(e.lastQty)) || Number(e.lastQty) <= 0) continue;
        const at = e.lastPurchased || e.at || null;
        if (!best || toMillis(at) > toMillis(best.at)) best = { qty: Number(e.lastQty), at };
    }
    if (!best) return null;
    return { lastQty: best.qty, lastQtyAt: best.at, avgQty: best.qty, count: 1 };
}
