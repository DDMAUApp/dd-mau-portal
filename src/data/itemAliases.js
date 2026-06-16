// itemAliases.js — learned "receipt name → master item" memory.
//
// Inventory pricing redesign, Phase 2e (Andrew 2026-06-15: "it needs to
// remember what the items are matched to … it didn't remember that CHI MEI
// GWA BUN is bao"). The fuzzy matcher (itemMatch.js) is stateless, so vendor
// line names that don't fuzzy-match (brand names, abbreviations) had to be
// hand-matched on EVERY scan. This collection records each confirmed match
// so the next scan applies it automatically.
//
// New Firestore collection (additive — only the scan modal reads it):
//   item_aliases_{location}/{normKey} = {
//     rawName,            // the receipt line as last seen (for display)
//     masterId,           // master item it maps to
//     masterName,         // snapshot
//     vendor,             // last vendor it came from (reference only)
//     count,              // times confirmed (increment)
//     by, updatedAt
//   }
// The doc id is a normalized, id-safe form of the raw name, so re-confirming
// the same name upserts the same doc instead of piling up duplicates.

import {
    collection, doc, onSnapshot, writeBatch, serverTimestamp, increment,
} from 'firebase/firestore';
import { db } from '../firebase';

export function aliasesCollPath(location) {
    return `item_aliases_${location}`;
}

// Raw receipt name → stable, Firestore-doc-id-safe key.
// Lowercase, non-alphanumerics collapse to '_', trimmed. Matching is on this
// exact normalized form (predictable: "remembers this exact item name").
export function normalizeAliasKey(name) {
    if (!name) return '';
    return String(name)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 1400);
}

// Live subscription → { [normKey]: { masterId, masterName, rawName, ... } }.
export function subscribeItemAliases(location, cb) {
    return onSnapshot(collection(db, aliasesCollPath(location)), (snap) => {
        const map = {};
        snap.forEach((d) => { map[d.id] = { key: d.id, ...d.data() }; });
        cb(map);
    }, (err) => { console.error('[itemAliases] subscribe error', err); cb({}); });
}

// Look up a learned match for a raw receipt name. Returns the alias entry or
// null. `aliasMap` is the object from subscribeItemAliases.
export function lookupAlias(aliasMap, rawName) {
    if (!aliasMap) return null;
    const key = normalizeAliasKey(rawName);
    if (!key) return null;
    return aliasMap[key] || null;
}

// Remember confirmed matches. entries: [{ rawName, masterId, masterName, vendor }].
// One upsert per distinct normalized name; count increments each save.
export async function learnAliases(location, entries, by) {
    const valid = (entries || []).filter((e) => e && e.rawName && e.masterId);
    if (!valid.length) return;
    const batch = writeBatch(db);
    const seen = new Set();
    let writes = 0;
    for (const e of valid) {
        const key = normalizeAliasKey(e.rawName);
        if (!key || seen.has(key)) continue;   // one write per key per save
        seen.add(key);
        batch.set(doc(db, aliasesCollPath(location), key), {
            rawName: e.rawName,
            masterId: String(e.masterId),
            masterName: e.masterName || null,
            vendor: e.vendor || null,
            by: by || null,
            count: increment(1),
            updatedAt: serverTimestamp(),
        }, { merge: true });
        writes++;
    }
    if (writes) await batch.commit();
}
