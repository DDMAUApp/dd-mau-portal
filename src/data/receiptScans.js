// receiptScans.js — persistent history of receipt/import scans.
//
// Inventory pricing redesign, Phase 2d (Andrew 2026-06-15: "i want it to
// show where it matched and i can edit it"). Until now a scan's matches
// lived only in the modal and were thrown away on Save — the resulting
// prices landed on item_prices but the scan itself left no record. This
// collection keeps each scan so the Pricing tab can list past scans and
// re-open one (review screen, editable) to fix matches and re-save.
//
// New Firestore collection (additive — nothing else reads it, so rollback
// is just "stop reading it"):
//   receipt_scans_{location}/{scanId} = {
//     vendor, date,            // receipt vendor + date (YYYY-MM-DD)
//     scannedBy,               // staff name
//     createdAt,               // client ms (stable sort key, set once)
//     scannedAt, updatedAt,    // serverTimestamps
//     savedCount,              // # of prices written on the last save
//     source,                  // 'receipt' | 'import'
//     lines: [ {               // EVERY extracted line (matched or not), so a
//        name, qty, price,     //   re-open shows the full receipt to edit
//        pack, masterId,
//        masterName,           //   snapshot — survives master-list edits
//        confidence, included
//     } ]
//   }

import {
    collection, doc, addDoc, setDoc, deleteDoc, onSnapshot,
    query, orderBy, limit, serverTimestamp,
} from 'firebase/firestore';
import { db } from '../firebase';

export function receiptScansCollPath(location) {
    return `receipt_scans_${location}`;
}

// Live subscription to recent scans for a location → array (newest first).
export function subscribeReceiptScans(location, cb, max = 40) {
    const q = query(
        collection(db, receiptScansCollPath(location)),
        orderBy('createdAt', 'desc'),
        limit(max),
    );
    return onSnapshot(q, (snap) => {
        const out = [];
        snap.forEach((d) => out.push({ id: d.id, ...d.data() }));
        cb(out);
    }, (err) => { console.error('[receiptScans] subscribe error', err); cb([]); });
}

// Create a new scan record. Returns the new doc id.
// `createdAtMs` is the stable sort key — Date.now() at the call site so the
// new row appears immediately (a pending serverTimestamp sorts as null and
// would briefly drop out of the orderBy).
export async function saveReceiptScan(location, scan, createdAtMs) {
    const ref = await addDoc(collection(db, receiptScansCollPath(location)), {
        vendor: scan.vendor || '',
        date: scan.date || null,
        scannedBy: scan.scannedBy || null,
        source: scan.source || 'receipt',
        savedCount: scan.savedCount ?? 0,
        lines: scan.lines || [],
        // Stable client-ms sort key. Default to now so a caller that forgets
        // to pass it still sorts the new scan to the top, not the bottom.
        createdAt: createdAtMs ?? Date.now(),
        scannedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
    });
    return ref.id;
}

// Update an existing scan record (after a re-open + edit + re-save).
// Merge so createdAt / scannedAt / scannedBy are preserved.
export async function updateReceiptScan(location, scanId, patch) {
    const ref = doc(db, receiptScansCollPath(location), String(scanId));
    await setDoc(ref, {
        ...(patch.vendor !== undefined ? { vendor: patch.vendor } : {}),
        ...(patch.date !== undefined ? { date: patch.date } : {}),
        ...(patch.savedCount !== undefined ? { savedCount: patch.savedCount } : {}),
        ...(patch.lines !== undefined ? { lines: patch.lines } : {}),
        updatedAt: serverTimestamp(),
    }, { merge: true });
}

// Remove a scan record (manager housekeeping for junk scans). This deletes
// only the scan's history row — the prices it wrote to item_prices stay.
export async function deleteReceiptScan(location, scanId) {
    await deleteDoc(doc(db, receiptScansCollPath(location), String(scanId)));
}
