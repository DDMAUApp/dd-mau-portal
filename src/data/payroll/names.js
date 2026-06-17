// Name normalization + matching — faithful JS port of app/engine/names.py.
//
// There is exactly ONE definition of "same person" in the payroll engine, and
// it lives here. Toast exports use "Last, First" with stray spaces / case drift
// ("Chandler , Marley", "cruz, Marcos"); the roster has separate first/last.
// The match KEY logic must be byte-identical to the Python engine because it is
// what joins a Toast row to a roster person — a mismatch silently routes someone
// to the red "NEW" section or drops their hours.

const NON_ALNUM = /[^a-z0-9]/g;

/**
 * Canonical match key: letters+digits only, lowercased, ORDER-PRESERVING.
 * Callers must pass parts in first-last order (use keyFromToast / keyFromMaster).
 * Mirrors names.norm_key.
 */
export function normKey(...parts) {
    const joined = parts
        .filter((p) => p !== null && p !== undefined && p !== '')
        .map((p) => String(p))
        .join(' ');
    return joined.toLowerCase().replace(NON_ALNUM, '');
}

/** "Last, First" → [first, last]. Falls back to "First Last". Mirrors split_toast_name. */
export function splitToastName(raw) {
    const collapsed = String(raw === null || raw === undefined ? '' : raw)
        .split(/\s+/).filter(Boolean).join(' ');
    if (collapsed.includes(',')) {
        const idx = collapsed.indexOf(',');
        const last = collapsed.slice(0, idx);
        const first = collapsed.slice(idx + 1);
        return [first.trim(), last.trim()];
    }
    const lastSpace = collapsed.lastIndexOf(' ');
    if (lastSpace >= 0) {
        return [collapsed.slice(0, lastSpace).trim(), collapsed.slice(lastSpace + 1).trim()];
    }
    return [collapsed, ''];
}

/**
 * Match key for a Toast export name, applying the alias map first. Alias keys
 * and values are Toast-style "Last, First"; matching is on normalized forms so
 * spacing/case in the alias table doesn't matter. Mirrors names.key_from_toast.
 */
export function keyFromToast(raw, aliases) {
    let cleaned = String(raw === null || raw === undefined ? '' : raw)
        .split(/\s+/).filter(Boolean).join(' ');
    if (aliases) {
        const ck = normKey(cleaned);
        for (const src of Object.keys(aliases)) {
            if (normKey(src) === ck) {
                cleaned = aliases[src];
                break;
            }
        }
    }
    const [first, last] = splitToastName(cleaned);
    return normKey(first, last);
}

/** Mirrors names.key_from_master. */
export function keyFromMaster(first, last) {
    return normKey(first, last);
}

/** Mirrors names.display_name. */
export function displayName(first, last) {
    return `${String(first || '').trim()} ${String(last || '').trim()}`.trim();
}

// ── difflib-compatible similarity (suggestMatch) ──────────────────────────
// suggestMatch is a SUGGESTION ONLY ("closest known name" for a NEW person);
// it is never auto-applied and never feeds the money path. We reproduce
// difflib.SequenceMatcher.ratio() closely so the suggested name usually matches
// the standalone app, but exact tie-breaking parity is not required.

function findLongestMatch(a, b, alo, ahi, blo, bhi, b2j) {
    let besti = alo, bestj = blo, bestsize = 0;
    let j2len = new Map();
    for (let i = alo; i < ahi; i++) {
        const newj2len = new Map();
        const indices = b2j.get(a[i]);
        if (indices) {
            for (const j of indices) {
                if (j < blo) continue;
                if (j >= bhi) break;
                const k = (j2len.get(j - 1) || 0) + 1;
                newj2len.set(j, k);
                if (k > bestsize) {
                    besti = i - k + 1;
                    bestj = j - k + 1;
                    bestsize = k;
                }
            }
        }
        j2len = newj2len;
    }
    return [besti, bestj, bestsize];
}

function matchingBlocksCount(a, b) {
    const b2j = new Map();
    for (let j = 0; j < b.length; j++) {
        const ch = b[j];
        if (!b2j.has(ch)) b2j.set(ch, []);
        b2j.get(ch).push(j);
    }
    let matches = 0;
    const queue = [[0, a.length, 0, b.length]];
    while (queue.length) {
        const [alo, ahi, blo, bhi] = queue.pop();
        const [i, j, k] = findLongestMatch(a, b, alo, ahi, blo, bhi, b2j);
        if (k > 0) {
            matches += k;
            if (alo < i && blo < j) queue.push([alo, i, blo, j]);
            if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
        }
    }
    return matches;
}

function ratio(a, b) {
    const total = a.length + b.length;
    if (total === 0) return 1.0;
    return (2.0 * matchingBlocksCount(a, b)) / total;
}

/**
 * Closest known key for an unknown name, or null. Suggestion only — never
 * auto-applied; the owner confirms in the UI. Mirrors names.suggest_match.
 */
export function suggestMatch(unknownKey, knownKeys, cutoff = 0.78) {
    let best = null;
    let bestRatio = cutoff; // difflib keeps matches with ratio >= cutoff
    for (const k of knownKeys) {
        const r = ratio(k, unknownKey);
        if (r >= cutoff && (best === null || r > bestRatio)) {
            bestRatio = r;
            best = k;
        }
    }
    return best;
}
