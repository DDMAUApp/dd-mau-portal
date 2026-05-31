// Order Mode — live session for placing real orders.
//
// Andrew 2026-05-19 — "in the cart I want an order mode... used while
// we actually place the order. check mark for ordered, out of stock
// tab, and a tab where we ordered from or at least able to take a
// note like only 5 available. ... toggle the vendor at the top that
// anything we check off while that is toggled saved as order from
// that vendor until we untoggle or toggle another. ... timestamps so
// when we look at the inventory audit we can see when someone added
// vs when that order was placed. ... once placed it creates another
// list of who what where when."
//
// Model
// ──────
//
// /order_sessions/{id}   — ONE open session per storeLocation
//   storeLocation:   'webster' | 'maryland'
//   status:          'open' | 'submitted' | 'cancelled'
//   createdAt, createdBy
//   currentVendor:   string | null              — current toggle
//   items: {                                    — map of itemId → row
//     [itemId]: {
//       itemName, qty, category, subcat,
//       status:     'pending' | 'ordered' | 'oos' | 'partial'
//       vendor:     string | null               — who we ordered from
//       note:       string | null               — "only 5 available"
//       checkedAt:  Timestamp | null            — when status flipped
//       checkedBy:  string | null
//     }
//   }
//   submittedAt, submittedBy
//   vendorTotals: {                             — derived on submit
//     [vendor]: { items: number, partialCount: number }
//   }
//
// /order_logs/{id}       — APPEND-ONLY history of every submitted session
//   Same shape as a submitted session + a `sessionId` back-ref so the
//   original session doc can be archived without losing the audit chain.
//
// /config/vendors        — admin-curated vendor list, merged with the
//   vendors derived from inventory item.preferredVendor + vendor +
//   vendorOptions[*]. Stored as { names: ['Sysco', ...] } so it's a
//   single doc that's cheap to read.

import { db } from '../firebase';
import {
    collection, doc, addDoc, getDoc, getDocs, setDoc, updateDoc,
    query, where, onSnapshot, serverTimestamp, orderBy, limit,
} from 'firebase/firestore';
import { recordAudit } from './audit';

export const ORDER_STATUS = Object.freeze({
    OPEN: 'open',
    SUBMITTED: 'submitted',
    CANCELLED: 'cancelled',
});

export const ITEM_STATUS = Object.freeze({
    PENDING: 'pending',
    ORDERED: 'ordered',
    OOS:     'oos',         // out of stock at this vendor
    PARTIAL: 'partial',     // ordered fewer than asked
});

// Spin up a fresh session from a cart payload. Cart row shape comes
// from the existing cart modal: { id, name, qty, category, pack, ... }.
// We snapshot the minimum we need to render the order screen — names
// and quantities — so if inventory drifts mid-session the session
// still shows what was being ordered at the time.
export async function createOrderSession({
    storeLocation, cartItems = [], createdBy,
}) {
    if (!storeLocation) throw new Error('storeLocation required');
    if (!createdBy) throw new Error('createdBy required');

    // Refuse to create a second session if one is already open for
    // this location — the workflow assumes one order at a time and
    // multi-open would be confusing.
    const existing = await getDocs(query(
        collection(db, 'order_sessions'),
        where('storeLocation', '==', storeLocation),
        where('status', '==', ORDER_STATUS.OPEN),
        limit(1),
    ));
    if (!existing.empty) {
        return existing.docs[0].id;  // resume
    }

    const items = {};
    for (const c of cartItems) {
        if (!c || c.qty == null) continue;
        items[c.id] = {
            itemName: c.name || c.id,
            itemNameEs: c.nameEs || null,
            qty: Number(c.qty) || 0,
            category: c.category || '',
            subcat: c.subcat || '',
            pack: c.pack || '',
            preferredVendor: c.preferredVendor || c.vendor || null,
            status: ITEM_STATUS.PENDING,
            vendor: null,
            note: null,
            checkedAt: null,
            checkedBy: null,
        };
    }

    const ref = await addDoc(collection(db, 'order_sessions'), {
        storeLocation,
        status: ORDER_STATUS.OPEN,
        currentVendor: null,
        items,
        createdAt: serverTimestamp(),
        createdBy,
    });
    recordAudit({
        action: 'order_session.create',
        actorName: createdBy,
        targetType: 'order_session',
        targetId: ref.id,
        details: { storeLocation, itemCount: Object.keys(items).length },
    });
    return ref.id;
}

// Update one item in the session. Pass any subset of fields; only
// non-undefined keys are written. status changes also stamp
// checkedAt / checkedBy so the audit log shows when each item was
// reconciled with the vendor.
export async function updateSessionItem({
    sessionId, itemId, status, vendor, prevVendor, note, qty, byName,
}) {
    if (!sessionId || !itemId) throw new Error('sessionId + itemId required');
    const patch = {};
    if (status !== undefined) {
        patch[`items.${itemId}.status`] = status;
        patch[`items.${itemId}.checkedAt`] = serverTimestamp();
        patch[`items.${itemId}.checkedBy`] = byName || null;
    }
    if (vendor !== undefined) patch[`items.${itemId}.vendor`] = vendor;
    // 2026-05-31 - prevVendor stores the vendor we are REPLACING when
    // an item is (re-)checked, so an Undo can restore it. Caller is
    // responsible for computing what prevVendor should be (typically:
    // the existing vendor if it differs from the new one). Pass null
    // explicitly to clear the memory after restoring on Undo.
    if (prevVendor !== undefined) patch[`items.${itemId}.prevVendor`] = prevVendor;
    if (note !== undefined)   patch[`items.${itemId}.note`]   = note;
    if (qty !== undefined)    patch[`items.${itemId}.qty`]    = Number(qty) || 0;
    if (Object.keys(patch).length === 0) return;
    await updateDoc(doc(db, 'order_sessions', sessionId), patch);
}

// Partial-fulfillment split. Use case Andrew flagged 2026-05-19:
// "I wanted 6 but they only have 3 — partial click 3, leaves 3
// to be ordered."
//
// What it does:
//   1. Looks up the current item, validates fulfilledQty against
//      the original qty
//   2. Updates the original row: qty = fulfilledQty,
//      status='partial', vendor=current, note carries the original
//      request quantity for the audit trail
//   3. If remaining > 0, creates a NEW pending row with the same
//      item meta + qty=remaining + a derived id (`${itemId}_r{n}`)
//      so admin can toggle a different vendor and try to fill the
//      rest. If fulfilledQty === original, no split is made —
//      effectively the same as marking 'ordered'.
//
// Edge cases:
//   • fulfilledQty <= 0 → fall through to OOS-style status
//   • fulfilledQty >= original → status='ordered', no split
//   • the split id must not collide with an existing remainder
//     from an earlier partial — we walk _r1, _r2, ... until free
export async function splitItemForPartial({
    sessionId, itemId, fulfilledQty, vendor, byName,
}) {
    if (!sessionId || !itemId) throw new Error('sessionId + itemId required');
    const ref = doc(db, 'order_sessions', sessionId);
    const snap = await getDoc(ref);
    if (!snap.exists()) throw new Error('session not found');
    const data = snap.data();
    const items = data.items || {};
    const orig = items[itemId];
    if (!orig) throw new Error('item not found in session');

    const originalQty = Number(orig.qty) || 0;
    const fulfilled = Math.max(0, Number(fulfilledQty) || 0);

    // Out-of-stock equivalent — they said they have none.
    if (fulfilled === 0) {
        await updateSessionItem({
            sessionId, itemId,
            status: ITEM_STATUS.OOS,
            vendor: vendor || null,
            byName,
        });
        return;
    }

    // Full fulfillment — just mark ordered, no split.
    if (fulfilled >= originalQty) {
        await updateSessionItem({
            sessionId, itemId,
            status: ITEM_STATUS.ORDERED,
            vendor: vendor || null,
            byName,
        });
        return;
    }

    // Genuine partial — split the row. Derive a non-colliding
    // remainder id.
    const remaining = originalQty - fulfilled;
    let n = 1;
    while (items[`${itemId}_r${n}`]) n++;
    const remainderId = `${itemId}_r${n}`;
    const noteSuffix = `(originally ${originalQty}, ${vendor || 'vendor'} only had ${fulfilled})`;
    const existingNote = orig.note ? `${orig.note} ` : '';

    const patch = {
        // Original row → partial with the actual fulfilled qty.
        [`items.${itemId}.qty`]: fulfilled,
        [`items.${itemId}.status`]: ITEM_STATUS.PARTIAL,
        [`items.${itemId}.vendor`]: vendor || null,
        [`items.${itemId}.note`]: `${existingNote}${noteSuffix}`,
        [`items.${itemId}.checkedAt`]: serverTimestamp(),
        [`items.${itemId}.checkedBy`]: byName || null,
        [`items.${itemId}.originalQty`]: originalQty,
        // New remainder row → pending, same meta, qty=remaining.
        [`items.${remainderId}`]: {
            itemName: orig.itemName,
            itemNameEs: orig.itemNameEs || null,
            qty: remaining,
            category: orig.category || '',
            subcat: orig.subcat || '',
            pack: orig.pack || '',
            preferredVendor: orig.preferredVendor || null,
            status: ITEM_STATUS.PENDING,
            vendor: null,
            note: `remaining from partial fill of ${originalQty}`,
            checkedAt: null,
            checkedBy: null,
            splitFromItemId: itemId,
        },
    };
    await updateDoc(ref, patch);
}

// Set / clear the currently-toggled vendor at the top of the order
// screen. Doesn't touch items — the item-level update is what
// associates a vendor with each row.
export async function setCurrentVendor({ sessionId, vendor }) {
    if (!sessionId) throw new Error('sessionId required');
    await updateDoc(doc(db, 'order_sessions', sessionId), {
        currentVendor: vendor || null,
    });
}

// Submit the session. Computes vendorTotals and writes an immutable
// /order_logs/{id} row, then marks the session 'submitted' (kept for
// audit; admin can cancel it instead via cancelSession). The log is
// the source of truth for "what was ordered when" — admins can query
// /order_logs without worrying about session-state churn.
export async function submitSession({ sessionId, byName }) {
    if (!sessionId) throw new Error('sessionId required');
    if (!byName) throw new Error('byName required');
    const ref = doc(db, 'order_sessions', sessionId);
    const snap = await getDoc(ref);
    if (!snap.exists()) throw new Error('session not found');
    const data = snap.data();
    if (data.status !== ORDER_STATUS.OPEN) {
        throw new Error('session already closed');
    }

    // Compute vendor totals — how many items from each vendor + how
    // many were ordered partial / oos.
    const vendorTotals = {};
    let totalOrdered = 0;
    let totalOos = 0;
    let totalPartial = 0;
    const items = data.items || {};
    for (const it of Object.values(items)) {
        const v = it.vendor || '(unassigned)';
        if (!vendorTotals[v]) vendorTotals[v] = { items: 0, partialCount: 0, oosCount: 0 };
        if (it.status === ITEM_STATUS.ORDERED) {
            vendorTotals[v].items += 1;
            totalOrdered += 1;
        } else if (it.status === ITEM_STATUS.PARTIAL) {
            vendorTotals[v].items += 1;
            vendorTotals[v].partialCount += 1;
            totalPartial += 1;
        } else if (it.status === ITEM_STATUS.OOS) {
            vendorTotals[v].oosCount += 1;
            totalOos += 1;
        }
    }

    // Write the immutable log row first so we never lose data even
    // if the session-update step fails.
    const logRef = await addDoc(collection(db, 'order_logs'), {
        sessionId,
        storeLocation: data.storeLocation,
        items: data.items,
        vendorTotals,
        totalOrdered,
        totalOos,
        totalPartial,
        submittedAt: serverTimestamp(),
        submittedBy: byName,
        createdAt: data.createdAt || null,
        createdBy: data.createdBy || null,
    });

    // Mark the session submitted.
    await updateDoc(ref, {
        status: ORDER_STATUS.SUBMITTED,
        submittedAt: serverTimestamp(),
        submittedBy: byName,
        vendorTotals,
        orderLogId: logRef.id,
    });

    recordAudit({
        action: 'order_session.submit',
        actorName: byName,
        targetType: 'order_session',
        targetId: sessionId,
        details: {
            orderLogId: logRef.id,
            storeLocation: data.storeLocation,
            ordered: totalOrdered, oos: totalOos, partial: totalPartial,
            vendors: Object.keys(vendorTotals),
        },
    });

    return logRef.id;
}

// Cancel an open session without committing it to order_logs. Used
// when admin started a session by accident and wants to bail.
export async function cancelSession({ sessionId, byName }) {
    if (!sessionId) throw new Error('sessionId required');
    await updateDoc(doc(db, 'order_sessions', sessionId), {
        status: ORDER_STATUS.CANCELLED,
        cancelledAt: serverTimestamp(),
        cancelledBy: byName || null,
    });
    recordAudit({
        action: 'order_session.cancel',
        actorName: byName || 'admin',
        targetType: 'order_session',
        targetId: sessionId,
    });
}

// Live subscription to the (at most one) open session for a location.
// Calls cb(null) if no session is open.
export function subscribeOpenSession(storeLocation, cb) {
    if (!storeLocation) { cb(null); return () => {}; }
    const q = query(
        collection(db, 'order_sessions'),
        where('storeLocation', '==', storeLocation),
        where('status', '==', ORDER_STATUS.OPEN),
        limit(1),
    );
    return onSnapshot(q, (snap) => {
        if (snap.empty) { cb(null); return; }
        const d = snap.docs[0];
        cb({ id: d.id, ...d.data() });
    }, (err) => {
        console.warn('subscribeOpenSession failed:', err);
        cb(null);
    });
}

// ── Vendor list ──────────────────────────────────────────────────────
//
// Two sources merged:
//   1. /config/vendors.names[]  — admin-curated additions
//   2. Every item.vendor / preferredVendor / vendorOptions[*].vendor
//      across the live inventory categories
//
// Subscribe so additions land immediately on every device.

export function subscribeVendorConfig(cb) {
    return onSnapshot(doc(db, 'config', 'vendors'), (snap) => {
        const data = snap.exists() ? snap.data() : {};
        cb(Array.isArray(data.names) ? data.names : []);
    }, (err) => {
        console.warn('subscribeVendorConfig failed:', err);
        cb([]);
    });
}

export async function addVendorName(name, byName) {
    if (!name || !name.trim()) return;
    const ref = doc(db, 'config', 'vendors');
    const snap = await getDoc(ref);
    const current = (snap.exists() && Array.isArray(snap.data().names))
        ? snap.data().names : [];
    const trimmed = name.trim();
    if (current.includes(trimmed)) return;
    const next = [...current, trimmed].sort((a, b) => a.localeCompare(b));
    await setDoc(ref, {
        names: next,
        updatedAt: serverTimestamp(),
        updatedBy: byName || null,
    }, { merge: true });
}

// Rename an admin-added vendor. Replaces the old name with the new
// one in the config list. Does NOT migrate vendor attributions on
// historical order_logs — those keep the old name as a snapshot.
// Auto-derived vendors (from inventory items) can't be renamed
// here; edit them through the inventory item data.
export async function renameVendorName(oldName, newName, byName) {
    if (!oldName || !newName) return;
    const trimmed = String(newName).trim();
    if (!trimmed || trimmed === oldName) return;
    const ref = doc(db, 'config', 'vendors');
    const snap = await getDoc(ref);
    const current = (snap.exists() && Array.isArray(snap.data().names))
        ? snap.data().names : [];
    if (!current.includes(oldName)) return;
    if (current.includes(trimmed)) {
        // Renaming to an existing name = effectively a remove of old.
        const next = current.filter(n => n !== oldName);
        await setDoc(ref, {
            names: next,
            updatedAt: serverTimestamp(),
            updatedBy: byName || null,
        }, { merge: true });
        return;
    }
    const next = current.map(n => n === oldName ? trimmed : n)
        .sort((a, b) => a.localeCompare(b));
    await setDoc(ref, {
        names: next,
        updatedAt: serverTimestamp(),
        updatedBy: byName || null,
    }, { merge: true });
}

export async function removeVendorName(name, byName) {
    if (!name) return;
    const ref = doc(db, 'config', 'vendors');
    const snap = await getDoc(ref);
    if (!snap.exists()) return;
    const current = Array.isArray(snap.data().names) ? snap.data().names : [];
    const next = current.filter(n => n !== name);
    await setDoc(ref, {
        names: next,
        updatedAt: serverTimestamp(),
        updatedBy: byName || null,
    }, { merge: true });
}

// Derive vendor names from a customInventory snapshot. Pure helper
// so the order modal can compose: derivedVendors + configVendors.
export function deriveVendorsFromInventory(customInventory) {
    const set = new Set();
    if (!Array.isArray(customInventory)) return [];
    for (const cat of customInventory) {
        for (const it of (cat.items || [])) {
            if (it.vendor) set.add(String(it.vendor));
            if (it.preferredVendor) set.add(String(it.preferredVendor));
            if (Array.isArray(it.vendorOptions)) {
                for (const vo of it.vendorOptions) {
                    if (vo && vo.vendor) set.add(String(vo.vendor));
                }
            }
        }
    }
    // Drop placeholder-ish values that aren't real vendors.
    const noisy = new Set(['Current App', '', null, undefined]);
    return Array.from(set).filter(v => !noisy.has(v)).sort((a, b) => a.localeCompare(b));
}
