// itemMatch.js — the shared "matrix" for matching an extracted vendor /
// receipt line name to a master inventory item.
//
// Inventory pricing redesign, Phase 2. Ported VERBATIM from Operations.jsx's
// invByName index + autoMatch fuzzy matcher so the receipt-scan flow and the
// file-import flow use ONE matcher (Andrew: "uses the same matrix to match
// the item from the import to the master list"). Pure + unit-tested.

// Build a searchable index from inventory categories:
//   [{ items: [{ id, name }, ...] }, ...]  →  [{ id, name, nameLower, keywords }]
export function buildMasterIndex(categories) {
    const out = [];
    for (const cat of (categories || [])) {
        for (const item of (cat?.items || [])) {
            const nameLower = String(item?.name || '').toLowerCase();
            if (!nameLower) continue;
            const keywords = nameLower.replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter((w) => w.length > 1);
            out.push({ id: item.id, name: item.name, nameLower, keywords });
        }
    }
    return out;
}

// Match a single extracted name to the best master item.
// Returns { id, score, confidence } or null (no confident match).
//   confidence: 'high' = exact substring or strong keyword overlap;
//               'low'  = weaker keyword overlap (worth a human glance).
// Threshold + scoring mirror Operations.jsx autoMatch exactly so results
// don't drift between the old Pricing tab and the new flows.
export function matchItemByName(name, index) {
    if (!name || !Array.isArray(index) || !index.length) return null;
    const sLower = String(name).toLowerCase();
    const sKeywords = sLower.replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter((w) => w.length > 2);
    if (!sKeywords.length) return null;

    let bestId = null, bestScore = 0, bestKind = null;
    for (const inv of index) {
        // Strong path: one name contains the other.
        if (inv.nameLower.includes(sLower) || sLower.includes(inv.nameLower)) {
            const score = Math.min(inv.nameLower.length, sLower.length) + 100;
            if (score > bestScore) { bestScore = score; bestId = inv.id; bestKind = 'substring'; }
            continue;
        }
        // Keyword-overlap path.
        let overlap = 0;
        for (const kw of sKeywords) {
            if (inv.keywords.some((ik) => ik === kw || (kw.length > 3 && ik.includes(kw)) || (ik.length > 3 && kw.includes(ik)))) overlap++;
        }
        const score = (overlap / Math.max(sKeywords.length, 1)) * 50;
        if (score > bestScore && overlap >= 1) { bestScore = score; bestId = inv.id; bestKind = 'keyword'; }
    }
    if (bestScore < 15) return null;
    return {
        id: bestId,
        score: bestScore,
        confidence: (bestKind === 'substring' || bestScore >= 40) ? 'high' : 'low',
    };
}
